//! Test-only scripted fake ACP agent (see `fake_agent.py` for the scenario
//! format). Never runs a real Claude or Cursor binary.

use crate::cli_detect::LoginStatus;
use crate::provider::claude_config::{ConfigDirInfo, ConfigDirSource};
use crate::provider::{
    AgentRequestKind, ClaudeProvider, CursorProvider, ProgramArgs, Provider, ProviderId,
    ProviderStatus, SessionOpts, SharedProvider, TerminalLaunch,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const SCRIPT: &str = include_str!("fake_agent.py");

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// `python3`, or `None` when the machine has none (tests then skip).
pub fn python3() -> Option<PathBuf> {
    let from_path = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    from_path
        .into_iter()
        .chain(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
                .iter()
                .map(PathBuf::from),
        )
        .map(|dir| dir.join("python3"))
        .find(|candidate| candidate.is_file())
}

/// One fake agent: its scenario, the folder it runs in, and the log of what
/// the client sent it. The folder is removed on drop.
pub struct FakeAgent {
    dir: PathBuf,
    program: ProgramArgs,
    received: PathBuf,
}

impl FakeAgent {
    /// `None` (with a note on stderr) when python3 is missing.
    pub fn new(name: &str, scenario: &Value) -> Option<Self> {
        let Some(python) = python3() else {
            eprintln!("skipping {name}: python3 not found");
            return None;
        };
        let dir = std::env::temp_dir().join(format!(
            "dct-fake-agent-{}-{}-{name}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("work")).unwrap();
        let script = dir.join("fake_agent.py");
        std::fs::write(&script, SCRIPT).unwrap();
        let scenario_path = dir.join("scenario.json");
        std::fs::write(&scenario_path, serde_json::to_string(scenario).unwrap()).unwrap();
        let received = dir.join("received.ndjson");
        std::fs::write(&received, "").unwrap();
        let program = ProgramArgs::new(
            python.display().to_string(),
            vec![
                // Unbuffered, no user site / env hooks.
                "-u".into(),
                "-I".into(),
                script.display().to_string(),
                scenario_path.display().to_string(),
                received.display().to_string(),
            ],
        );
        Some(Self {
            dir,
            program,
            received,
        })
    }

    /// Working folder for the session (an empty temp folder).
    pub fn work_dir(&self) -> PathBuf {
        self.dir.join("work")
    }

    pub fn program(&self) -> ProgramArgs {
        self.program.clone()
    }

    /// A provider that behaves like `base` but launches this fake.
    pub fn provider(&self, base: ProviderId) -> SharedProvider {
        let inner: SharedProvider = match base {
            ProviderId::Cursor => Arc::new(CursorProvider),
            ProviderId::Claude => Arc::new(ClaudeProvider::with_config(
                &Default::default(),
                ConfigDirInfo {
                    path: self.dir.join("claude-config").display().to_string(),
                    display: "fake".to_string(),
                    source: ConfigDirSource::Setting,
                    exists: false,
                },
            )),
        };
        Arc::new(FakeProvider {
            inner,
            program: self.program(),
        })
    }

    /// Every message the client wrote to the agent, in order.
    pub fn received(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.received)
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    pub fn received_text(&self) -> String {
        std::fs::read_to_string(&self.received).unwrap_or_default()
    }

    /// Params of every request with this method.
    pub fn sent(&self, method: &str) -> Vec<Value> {
        self.received()
            .into_iter()
            .filter(|msg| msg.get("method").and_then(Value::as_str) == Some(method))
            .map(|msg| msg.get("params").cloned().unwrap_or(Value::Null))
            .collect()
    }
}

impl Drop for FakeAgent {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A real provider (Claude or Cursor rules) whose ACP command is the fake.
struct FakeProvider {
    inner: SharedProvider,
    program: ProgramArgs,
}

impl Provider for FakeProvider {
    fn id(&self) -> ProviderId {
        self.inner.id()
    }
    fn detect(&self) -> ProviderStatus {
        unreachable!("tests never detect CLIs")
    }
    fn login_status(&self) -> LoginStatus {
        unreachable!("tests never ask a CLI for its login")
    }
    fn acp_command(&self, model: Option<&str>) -> Result<ProgramArgs, String> {
        let mut program = self.program.clone();
        if let Some(model) = model {
            program.env.push(("FAKE_SPAWN_MODEL".into(), model.into()));
        }
        Ok(program)
    }
    fn auth_step(&self) -> Option<(String, Value)> {
        self.inner.auth_step()
    }
    fn session_new_meta(&self, opts: &SessionOpts) -> Option<Value> {
        self.inner.session_new_meta(opts)
    }
    fn mode_for_role(&self, role_id: &str, role_mode: &str, available: &[String]) -> String {
        self.inner.mode_for_role(role_id, role_mode, available)
    }
    fn classify_request(&self, method: &str, params: &Value) -> AgentRequestKind {
        self.inner.classify_request(method, params)
    }
    fn terminal_command(&self, _req: &TerminalLaunch) -> Result<ProgramArgs, String> {
        Err("no terminals in tests".into())
    }
    fn plans_dir(&self) -> Option<PathBuf> {
        None
    }
    fn config_dir(&self) -> Option<ConfigDirInfo> {
        self.inner.config_dir()
    }
    fn missing_message(&self) -> String {
        "fake agent missing".into()
    }
    fn auth_error_message(&self, detail: &str) -> String {
        self.inner.auth_error_message(detail)
    }
}

/// `result` of a captured Claude ACP 0.88 fixture (`fixtures/acp/claude`).
pub fn claude_fixture_result(name: &str, pointer: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/acp/claude")
        .join(name);
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    value.pointer(pointer).cloned().unwrap()
}
