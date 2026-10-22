//! Pipeline v2 signals (ADR-015, plan V2a): the `dcterminal bridge`
//! subcommand and the app side around it.
//!
//! A bridged stage's `claude` runs this executable as its hooks
//! (`--settings`) and as its one-tool MCP server (`--mcp-config`):
//!
//! - `dcterminal bridge hook --run-dir <dir> --run <id> --stage <key> --tab <id> --event <name>`
//!   (one process per hook event, payload on stdin; see `hook`)
//! - `dcterminal bridge mcp --run-dir <dir> --run <id> --stage <key> --tab <id>`
//!   (lives with the stage; see `mcp`)
//!
//! The bridge writes only inside the run folder named on its command line,
//! after checking the run id, the stage key and the tab against what the app
//! wrote there at launch (D37). It makes no network calls, takes none of the
//! app's locks and starts no window: `main` runs it before Tauri (T10).
//!
//! Run folder (`<app data>/runs/<runId>/`, `folder`):
//!
//! ```text
//! run.json                      the run id (app)
//! plan.md, tasks.json           the Planner's plan and tasks (ExitPlanMode hook)
//! prs.json, prs-<lane>.json     what each Implementer reported (submit_result)
//! inbox/                        finished turns (Stop hook) and Needs you
//!                               (PermissionRequest, Notification) for the app
//! bridge.log                    what went wrong, unknown payload fields
//! stages/<stage>[@lane]/
//!   stage.json                  stage, role, lane, owning tab, result schema (app)
//!   mode                        autopilot | manual | takeover (app)
//!   turn.json                   current turn: prompt_id, start, blocked, end
//!   results/<turn>.json         what submit_result accepted, already checked
//!   payloads/<Event>.json       newest raw hook payload per event
//!   needs.json                  the last Needs you posted (Notification dedupe)
//! ```
//!
//! `launch` decides which tabs launch bridged and builds their flags;
//! `gate` checks the Claude Code version and `disableAllHooks` at a bridged
//! launch (D24) and falls back to engine 1; `watch` hands finished turns to
//! the run actor (`run_actor`, V3).

pub mod folder;
pub mod gate;
mod hook;
pub mod launch;
mod mcp;
pub mod schema;
#[cfg(test)]
mod tests;
pub mod watch;

pub use folder::{
    BridgeNeeds, BridgeTurn, NeedsSource, PlannedTask, ResultKind, RunTasks, StageMode, TurnOutcome,
};
pub use hook::{stop_decision, StopDecision};
pub use launch::{BridgePlan, BridgeTag};

use folder::{OpenError, StageDir};
use std::io::{BufReader, Read};
use std::path::PathBuf;

/// When this process was started as `dcterminal bridge …`: run it and give
/// the exit code. `None` for a normal app start.
pub fn main_from_args() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("bridge") {
        return None;
    }
    Some(run_cli(&args[1..]))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    Hook { event: String },
    Mcp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Cli {
    mode: Mode,
    run_dir: PathBuf,
    run_id: String,
    stage_key: String,
    tab_id: String,
}

fn parse_cli(args: &[String]) -> Result<Cli, String> {
    let mut iter = args.iter();
    let mode = iter.next().map(String::as_str);
    let (mut run_dir, mut run_id, mut stage, mut tab, mut event) = (None, None, None, None, None);
    while let Some(flag) = iter.next() {
        let slot = match flag.as_str() {
            "--run-dir" => &mut run_dir,
            "--run" => &mut run_id,
            "--stage" => &mut stage,
            "--tab" => &mut tab,
            "--event" => &mut event,
            other => return Err(format!("unknown argument {other:?}")),
        };
        *slot = Some(
            iter.next()
                .ok_or_else(|| format!("{flag} needs a value"))?
                .clone(),
        );
    }
    let need =
        |value: Option<String>, flag: &str| value.ok_or_else(|| format!("{flag} is required"));
    let mode = match mode {
        Some("hook") => Mode::Hook {
            event: need(event, "--event")?,
        },
        Some("mcp") => Mode::Mcp,
        other => return Err(format!("expected `hook` or `mcp`, got {other:?}")),
    };
    Ok(Cli {
        mode,
        run_dir: PathBuf::from(need(run_dir, "--run-dir")?),
        run_id: need(run_id, "--run")?,
        stage_key: need(stage, "--stage")?,
        tab_id: need(tab, "--tab")?,
    })
}

fn run_cli(args: &[String]) -> i32 {
    let cli = match parse_cli(args) {
        Ok(cli) => cli,
        Err(why) => {
            eprintln!("dcterminal bridge: {why}");
            // Not 2: for a hook, exit 2 blocks the stop or erases the prompt.
            return 1;
        }
    };
    match &cli.mode {
        Mode::Hook { event } => run_hook(&cli, event, std::io::stdin(), &mut std::io::stdout()),
        Mode::Mcp => {
            let dir = match StageDir::open(&cli.run_dir, &cli.run_id, &cli.stage_key, &cli.tab_id) {
                Ok(dir) => Some(dir),
                // Still served: each call answers that the stage moved on.
                Err(OpenError::Stale) => None,
                Err(OpenError::Invalid(why)) => {
                    eprintln!("dcterminal bridge: {why}");
                    return 1;
                }
            };
            let server = mcp::Server {
                kind: dir.map_or(ResultKind::Reviewer, |dir| dir.info.result),
                run_dir: cli.run_dir.clone(),
                run_id: cli.run_id.clone(),
                stage_key: cli.stage_key.clone(),
                tab_id: cli.tab_id.clone(),
            };
            mcp::serve(&server, BufReader::new(std::io::stdin()), std::io::stdout())
        }
    }
}

/// One hook event. A hook must never wedge Claude: a stale tab exits 0 with
/// nothing done, a bad setup exits 1 (Claude Code shows it and goes on), and
/// only a block or an allow prints anything.
fn run_hook(cli: &Cli, event: &str, mut input: impl Read, output: &mut impl std::io::Write) -> i32 {
    let mut raw = String::new();
    if let Err(err) = input.read_to_string(&mut raw) {
        eprintln!("dcterminal bridge: could not read the {event} payload: {err}");
        return 1;
    }
    let dir = match StageDir::open(&cli.run_dir, &cli.run_id, &cli.stage_key, &cli.tab_id) {
        Ok(dir) => dir,
        Err(OpenError::Stale) => return 0,
        Err(OpenError::Invalid(why)) => {
            eprintln!("dcterminal bridge: {why}");
            return 1;
        }
    };
    let payload = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(payload) => payload,
        Err(err) => {
            dir.log(&format!("{event} payload is not JSON: {err}"));
            return 1;
        }
    };
    match hook::handle(&dir, event, &payload) {
        Ok(Some(reply)) => {
            let _ = writeln!(output, "{reply}");
            let _ = output.flush();
            0
        }
        Ok(None) => 0,
        Err(why) => {
            dir.log(&format!("{event}: {why}"));
            eprintln!("dcterminal bridge: {why}");
            1
        }
    }
}
