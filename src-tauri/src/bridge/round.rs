//! A QA round (R1): what a Triage stage hands over through ExitPlanMode
//! instead of tasks. The plan text ends with a fenced ```json block holding
//! `round`: the plans the tickets were grouped into, the merge waves, the
//! merge order per repo and the tickets left out. The hook checks it here,
//! naming every problem at once as the tasks check does, and on success
//! writes `round.md` (the plan text, for you to read) and `round.json` (for
//! the round runner) at the run folder's top.
//!
//! Rules: every ticket of the run's `tickets.json` is in exactly one plan or
//! in `excluded`; a plan's repos are names from `repos.json` (a deferred
//! plan's fix is outside our repos, so its repos are not checked); waves run
//! 1, 2, … with no gap and every active plan has one; `mergeOrder` names
//! only plans that touch that repo, lists every active plan of it, and
//! never merges a later wave's plan before an earlier wave's or goes round
//! in a circle across repos; plan ids are unique, and there are at most
//! [`MAX_PLANS`].

use super::folder::{self, read_json, write_atomic, write_json, SCHEMA};
use super::schema::{fenced_blocks, list, required_text, unknown_fields};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io;
use std::path::Path;

/// Triage's round, as the round runner reads it (R1).
pub const ROUND_FILE: &str = "round.json";
/// Triage's plan text, as it handed it to ExitPlanMode (R1).
pub const ROUND_MD_FILE: &str = "round.md";
/// Plans one round may hold.
pub const MAX_PLANS: usize = 30;
const MAX_TITLE_CHARS: usize = 300;
const MAX_TEXT_CHARS: usize = 4000;
const MAX_TICKETS_PER_PLAN: usize = 100;
const MAX_REPOS_PER_PLAN: usize = 12;

const BLOCK_FIELDS: [&str; 2] = ["schema", "round"];
const ROUND_FIELDS: [&str; 4] = ["plans", "waves", "mergeOrder", "excluded"];
const PLAN_FIELDS: [&str; 8] = ["id", "title", "tickets", "repos", "status", "reason", "wave", "summary"];
const WAVE_FIELDS: [&str; 2] = ["n", "why"];
const EXCLUDED_FIELDS: [&str; 2] = ["ticket", "reason"];

/// What a plan of the round is (R1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanStatus {
    /// Planned for this round: it gets a run of its own.
    Active,
    /// The fix is outside our repos: nothing merges from it this round.
    Deferred,
    /// Waiting on a product decision: it starts only once you unpark it.
    Parked,
}

impl PlanStatus {
    pub fn label(self) -> &'static str {
        match self {
            PlanStatus::Active => "active",
            PlanStatus::Deferred => "deferred",
            PlanStatus::Parked => "parked",
        }
    }
}

/// One plan of a round: the tickets that share a contract, in the repos
/// it touches (one pull request per repo, E7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundPlan {
    /// `plan1`, `plan2`, … (lower case).
    pub id: String,
    pub title: String,
    /// Ticket ids (or custom ids) of the run's `tickets.json`, as written.
    pub tickets: Vec<String>,
    /// Repo names from Settings › Repos, as Settings spells them; empty for
    /// the run's own folder.
    #[serde(default)]
    pub repos: Vec<String>,
    pub status: PlanStatus,
    /// Why a plan is deferred or parked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The merge wave (1..N); a deferred or parked plan may have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wave: Option<u32>,
    pub summary: String,
}

/// One merge wave and why its plans go together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundWave {
    pub n: u32,
    pub why: String,
}

/// A ticket left out of every plan, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundExcluded {
    pub ticket: String,
    pub reason: String,
}

/// The round itself (the `round` of Triage's block).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Round {
    pub plans: Vec<RoundPlan>,
    #[serde(default)]
    pub waves: Vec<RoundWave>,
    /// Plan ids per repo, in the order their pull requests merge.
    #[serde(default)]
    pub merge_order: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub excluded: Vec<RoundExcluded>,
}

impl Round {
    pub fn plan(&self, id: &str) -> Option<&RoundPlan> {
        self.plans.iter().find(|plan| plan.id == id)
    }
}

/// `round.json`: Triage's latest round.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRound {
    pub schema: u32,
    pub run_id: String,
    pub stage_key: String,
    /// The Triage turn that handed the round over.
    pub turn: String,
    pub at: String,
    #[serde(flatten)]
    pub round: Round,
}

/// A ticket of `tickets.json` as the round check knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownTicket {
    pub id: String,
    pub custom_id: Option<String>,
}

impl KnownTicket {
    fn names(&self, text: &str) -> bool {
        self.id.eq_ignore_ascii_case(text) || self.custom_id.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(text))
    }
}

/// The tickets of the run's `tickets.json` (C2); `None` without one (a
/// dictated round, whose ticket names are not checked).
pub fn known_tickets(run_dir: &Path) -> Option<Vec<KnownTicket>> {
    let snapshot: Value = read_json(&run_dir.join(folder::TICKETS_FILE))?;
    let tickets = snapshot.get("tickets")?.as_array()?;
    Some(
        tickets
            .iter()
            .filter_map(|ticket| {
                let text = |key: &str| ticket.get(key).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
                Some(KnownTicket { id: text("id")?, custom_id: text("customId") })
            })
            .collect(),
    )
}

/// The round of the plan Triage handed to ExitPlanMode: its last fenced
/// JSON block holding `round`. `repos`: the names of `repos.json`;
/// `tickets`: the run's `tickets.json`, when it has one. `Err` names each
/// problem, for the deny reason that sends Triage back to fix them.
pub fn triage_round(plan: &str, repos: &[String], tickets: Option<&[KnownTicket]>) -> Result<Round, Vec<String>> {
    if plan.trim().is_empty() {
        return Err(vec!["the plan is empty".to_string()]);
    }
    let mut unreadable = Vec::new();
    let mut found = None;
    for (info, body) in fenced_blocks(plan) {
        if !(info.is_empty() || info == "json" || info == "jsonc") {
            continue;
        }
        match serde_json::from_str::<Value>(&body) {
            Ok(value) if value.get("round").is_some() => found = Some(value),
            Ok(_) => {}
            Err(err) if info.starts_with("json") || body.contains("\"round\"") => {
                unreadable.push(format!("a ```json block is not valid JSON ({err})"));
            }
            Err(_) => {}
        }
    }
    let Some(value) = found else {
        let mut problems = unreadable;
        problems.push("the plan has no ```json block with `round`: end the plan with one (see the example)".to_string());
        return Err(problems);
    };
    check_round(&value, repos, tickets)
}

fn plan_id_ok(id: &str) -> bool {
    id.strip_prefix("plan")
        .is_some_and(|n| !n.is_empty() && n.len() <= 2 && !n.starts_with('0') && n.chars().all(|ch| ch.is_ascii_digit()))
}

/// A list of strings: trimmed, empty ones dropped.
fn strings(value: Option<&Value>, at: &str, max_items: usize, problems: &mut Vec<String>) -> Vec<String> {
    let items = match value {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(items)) => items,
        Some(other) => {
            problems.push(format!("`{at}` must be a list of strings, not {other}"));
            return Vec::new();
        }
    };
    if items.len() > max_items {
        problems.push(format!("`{at}` has {} items; at most {max_items}", items.len()));
    }
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        match item {
            Value::String(text) if text.trim().is_empty() => {}
            Value::String(text) if text.trim().chars().count() > MAX_TITLE_CHARS => {
                problems.push(format!("`{at}[{index}]` is longer than {MAX_TITLE_CHARS} characters"));
            }
            Value::String(text) => out.push(text.trim().to_string()),
            other => problems.push(format!("`{at}[{index}]` must be a string, not {other}")),
        }
    }
    out
}

fn optional_text(object: &Map<String, Value>, at: &str, key: &str, problems: &mut Vec<String>) -> Option<String> {
    match object.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.trim().is_empty() => None,
        Some(Value::String(text)) if text.trim().chars().count() > MAX_TEXT_CHARS => {
            problems.push(format!("`{at}{key}` is longer than {MAX_TEXT_CHARS} characters"));
            None
        }
        Some(Value::String(text)) => Some(text.trim().to_string()),
        Some(other) => {
            problems.push(format!("`{at}{key}` must be a string, not {other}"));
            None
        }
    }
}

/// A wave number: a whole number from 1.
fn wave_number(value: Option<&Value>, at: &str, problems: &mut Vec<String>) -> Option<u32> {
    match value {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_u64().filter(|n| *n >= 1 && *n <= MAX_PLANS as u64) {
            Some(n) => Some(n as u32),
            None => {
                problems.push(format!("`{at}` must be a wave number from 1 to {MAX_PLANS}, not {value}"));
                None
            }
        },
    }
}

/// The repo name as Settings spells it, when `name` is one (any case).
fn known_repo<'a>(repos: &'a [String], name: &str) -> Option<&'a String> {
    repos.iter().find(|repo| repo.eq_ignore_ascii_case(name))
}

fn repos_text(repos: &[String]) -> String {
    if repos.is_empty() {
        "none are set up in DCTerminal's Settings › Repos".to_string()
    } else {
        format!("the repos are {}", list(&repos.iter().map(String::as_str).collect::<Vec<_>>()))
    }
}

fn check_round(value: &Value, repos: &[String], tickets: Option<&[KnownTicket]>) -> Result<Round, Vec<String>> {
    let Some(block) = value.as_object() else {
        return Err(vec!["the round block must be a JSON object with `round`".to_string()]);
    };
    let mut problems = Vec::new();
    unknown_fields(block, "", &BLOCK_FIELDS, &mut problems);
    match block.get("schema") {
        None => {}
        Some(value) if value.as_u64() == Some(u64::from(SCHEMA)) => {}
        Some(value) => problems.push(format!("`schema` must be {SCHEMA}, not {value}")),
    }
    let Some(object) = block.get("round").and_then(Value::as_object) else {
        problems.push("`round` must be an object with `plans`, `waves`, `mergeOrder` and `excluded`".to_string());
        return Err(problems);
    };
    unknown_fields(object, "round.", &ROUND_FIELDS, &mut problems);
    let plans = check_plans(object.get("plans"), repos, tickets, &mut problems);
    let waves = check_waves(object.get("waves"), &plans, &mut problems);
    let excluded = check_excluded(object.get("excluded"), tickets, &mut problems);
    if let Some(known) = tickets {
        check_coverage(&plans, &excluded, known, &mut problems);
    }
    let merge_order = check_merge_order(object.get("mergeOrder"), &plans, repos, &mut problems);
    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(Round { plans, waves, merge_order, excluded })
}

fn check_plans(value: Option<&Value>, repos: &[String], tickets: Option<&[KnownTicket]>, problems: &mut Vec<String>) -> Vec<RoundPlan> {
    let Some(items) = value.and_then(Value::as_array) else {
        problems.push(format!("`round.plans` must be a list of 1 to {MAX_PLANS} plans"));
        return Vec::new();
    };
    if items.is_empty() {
        problems.push("`round.plans` is empty: a round has at least one plan".to_string());
    }
    if items.len() > MAX_PLANS {
        problems.push(format!("`round.plans` has {} plans; at most {MAX_PLANS}", items.len()));
    }
    let mut plans: Vec<RoundPlan> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let at = format!("round.plans[{index}]");
        let Some(plan) = item.as_object() else {
            problems.push(format!("`{at}` must be an object with `id`, `title`, `tickets`, `repos`, `status`, `wave` and `summary`"));
            continue;
        };
        unknown_fields(plan, &format!("{at}."), &PLAN_FIELDS, problems);
        let id = required_text(plan, &format!("{at}."), "id", 20, problems).map(|id| id.to_lowercase());
        // A plan whose id reads is kept for the checks across plans even
        // with problems of its own, so one bad field is not reported again
        // as its tickets missing or its merge order naming no plan.
        let mut keep = false;
        if let Some(id) = id.as_deref() {
            if !plan_id_ok(id) {
                problems.push(format!("`{at}.id` {id:?} must be plan1, plan2, …"));
            } else if ids.iter().any(|seen| seen == id) {
                problems.push(format!("plan id {id:?} is used twice"));
            } else {
                ids.push(id.to_string());
                keep = true;
            }
        }
        let name = id.clone().unwrap_or_else(|| at.clone());
        let title = required_text(plan, &format!("{at}."), "title", MAX_TITLE_CHARS, problems);
        let summary = required_text(plan, &format!("{at}."), "summary", MAX_TEXT_CHARS, problems);
        let status = match plan.get("status").and_then(Value::as_str).map(str::trim) {
            Some("active") => Some(PlanStatus::Active),
            Some("deferred") => Some(PlanStatus::Deferred),
            Some("parked") => Some(PlanStatus::Parked),
            _ => {
                problems.push(format!("`{at}.status` must be \"active\", \"deferred\" or \"parked\""));
                None
            }
        };
        let reason = optional_text(plan, &format!("{at}."), "reason", problems);
        if matches!(status, Some(PlanStatus::Deferred | PlanStatus::Parked)) && reason.is_none() {
            let what = status.map(PlanStatus::label).unwrap_or_default();
            problems.push(format!("{name} is {what}, so it needs a `reason` (why it is {what})"));
        }
        let wave = wave_number(plan.get("wave"), &format!("{at}.wave"), problems);
        if status == Some(PlanStatus::Active) && wave.is_none() && plan.get("wave").is_none_or(Value::is_null) {
            problems.push(format!("{name} is active, so it needs a `wave`"));
        }
        let plan_tickets = strings(plan.get("tickets"), &format!("{at}.tickets"), MAX_TICKETS_PER_PLAN, problems);
        if plan_tickets.is_empty() && plan.get("tickets").is_some_and(Value::is_array) {
            problems.push(format!("{name} has no tickets"));
        } else if plan.get("tickets").is_none_or(Value::is_null) {
            problems.push(format!("`{at}.tickets` is missing: list the ticket ids the plan fixes"));
        }
        for ticket in &plan_tickets {
            ticket_problem(ticket, &format!("{at}.tickets"), tickets, problems);
        }
        let named = strings(plan.get("repos"), &format!("{at}.repos"), MAX_REPOS_PER_PLAN, problems);
        let mut plan_repos: Vec<String> = Vec::new();
        for repo in named {
            // A deferred plan's fix is outside our repos (E6 example: a
            // gateway we do not own), so its repos are only listed.
            let spelled = if status == Some(PlanStatus::Deferred) {
                Some(known_repo(repos, &repo).cloned().unwrap_or(repo.clone()))
            } else {
                match known_repo(repos, &repo) {
                    Some(known) => Some(known.clone()),
                    None => {
                        problems.push(format!(
                            "`{at}.repos` {repo:?} is not a repo of this run ({}); a plan whose fix is outside these repos is `deferred`",
                            repos_text(repos)
                        ));
                        None
                    }
                }
            };
            if let Some(spelled) = spelled {
                if plan_repos.iter().any(|seen| seen.eq_ignore_ascii_case(&spelled)) {
                    problems.push(format!("{name} lists the repo {spelled:?} twice"));
                } else {
                    plan_repos.push(spelled);
                }
            }
        }
        if keep {
            plans.push(RoundPlan {
                id: id.unwrap_or_default(),
                title: title.unwrap_or_default(),
                tickets: plan_tickets,
                repos: plan_repos,
                status: status.unwrap_or(PlanStatus::Active),
                reason,
                wave,
                summary: summary.unwrap_or_default(),
            });
        }
    }
    plans
}

/// A ticket name that is not a ticket: spaces, or not in `tickets.json`.
fn ticket_problem(ticket: &str, at: &str, tickets: Option<&[KnownTicket]>, problems: &mut Vec<String>) {
    if ticket.chars().any(char::is_whitespace) {
        problems.push(format!("`{at}` {ticket:?} has spaces in it: use the ticket id, such as \"86c0abc12\" or \"QA-129\""));
        return;
    }
    if let Some(known) = tickets.filter(|known| !known.iter().any(|k| k.names(ticket))) {
        let shown: Vec<&str> = known.iter().map(|k| k.id.as_str()).take(12).collect();
        problems.push(format!(
            "`{at}` {ticket:?} is not a ticket of this run's tickets.json (it has {})",
            if shown.is_empty() { "none".to_string() } else { list(&shown) }
        ));
    }
}

fn check_waves(value: Option<&Value>, plans: &[RoundPlan], problems: &mut Vec<String>) -> Vec<RoundWave> {
    let items = match value {
        None | Some(Value::Null) => &Vec::new(),
        Some(Value::Array(items)) => items,
        Some(other) => {
            problems.push(format!("`round.waves` must be a list of waves, not {other}"));
            return Vec::new();
        }
    };
    let mut waves: Vec<RoundWave> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let at = format!("round.waves[{index}]");
        let Some(wave) = item.as_object() else {
            problems.push(format!("`{at}` must be an object with `n` and `why`"));
            continue;
        };
        unknown_fields(wave, &format!("{at}."), &WAVE_FIELDS, problems);
        let n = match wave.get("n") {
            None | Some(Value::Null) => {
                problems.push(format!("`{at}.n` is missing"));
                None
            }
            value => wave_number(value, &format!("{at}.n"), problems),
        };
        let why = required_text(wave, &format!("{at}."), "why", MAX_TEXT_CHARS, problems);
        if let (Some(n), Some(why)) = (n, why) {
            if waves.iter().any(|w| w.n == n) {
                problems.push(format!("wave {n} is listed twice"));
            } else {
                waves.push(RoundWave { n, why });
            }
        }
    }
    waves.sort_by_key(|w| w.n);
    // 1, 2, …, N with no gap.
    for (index, wave) in waves.iter().enumerate() {
        let want = index as u32 + 1;
        if wave.n != want {
            problems.push(format!("the waves must run 1, 2, 3, … with no gap: wave {want} is missing"));
            break;
        }
    }
    for plan in plans {
        if let Some(n) = plan.wave.filter(|n| !waves.iter().any(|w| w.n == *n)) {
            problems.push(format!("{} is in wave {n}, which is not in `round.waves`", plan.id));
        }
    }
    for wave in &waves {
        if !plans.iter().any(|plan| plan.wave == Some(wave.n)) {
            problems.push(format!("wave {} has no plan", wave.n));
        }
    }
    waves
}

fn check_excluded(value: Option<&Value>, tickets: Option<&[KnownTicket]>, problems: &mut Vec<String>) -> Vec<RoundExcluded> {
    let items = match value {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(items)) => items,
        Some(other) => {
            problems.push(format!("`round.excluded` must be a list of {{\"ticket\", \"reason\"}}, not {other}"));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let at = format!("round.excluded[{index}]");
        let Some(entry) = item.as_object() else {
            problems.push(format!("`{at}` must be an object with `ticket` and `reason`"));
            continue;
        };
        let before = problems.len();
        unknown_fields(entry, &format!("{at}."), &EXCLUDED_FIELDS, problems);
        let ticket = required_text(entry, &format!("{at}."), "ticket", MAX_TITLE_CHARS, problems);
        let reason = required_text(entry, &format!("{at}."), "reason", MAX_TEXT_CHARS, problems);
        if let Some(ticket) = ticket.as_deref() {
            ticket_problem(ticket, &format!("{at}.ticket"), tickets, problems);
        }
        if problems.len() == before {
            out.push(RoundExcluded { ticket: ticket.unwrap_or_default(), reason: reason.unwrap_or_default() });
        }
    }
    out
}

/// Every ticket of `tickets.json` is in exactly one plan or in `excluded`.
fn check_coverage(plans: &[RoundPlan], excluded: &[RoundExcluded], known: &[KnownTicket], problems: &mut Vec<String>) {
    let mut missing = Vec::new();
    for ticket in known {
        let mut places: Vec<String> = plans
            .iter()
            .filter(|plan| plan.tickets.iter().any(|t| ticket.names(t)))
            .map(|plan| plan.id.clone())
            .collect();
        if excluded.iter().any(|e| ticket.names(&e.ticket)) {
            places.push("excluded".to_string());
        }
        match places.len() {
            0 => missing.push(ticket.id.clone()),
            1 => {}
            _ => problems.push(format!(
                "ticket {} is in {}: put it in exactly one plan (the one that finishes it) or in `excluded`",
                ticket.id,
                places.join(" and ")
            )),
        }
    }
    if !missing.is_empty() {
        let shown: Vec<&str> = missing.iter().map(String::as_str).collect();
        problems.push(format!(
            "every ticket of tickets.json must be in a plan or in `excluded`; these are in neither: {}",
            list(&shown)
        ));
    }
}

fn check_merge_order(
    value: Option<&Value>,
    plans: &[RoundPlan],
    repos: &[String],
    problems: &mut Vec<String>,
) -> BTreeMap<String, Vec<String>> {
    let mut order: BTreeMap<String, Vec<String>> = BTreeMap::new();
    match value {
        None | Some(Value::Null) => {}
        Some(Value::Object(object)) => {
            for (repo, ids) in object {
                let at = format!("round.mergeOrder.{repo}");
                let Some(spelled) = known_repo(repos, repo.trim()).cloned() else {
                    problems.push(format!("`round.mergeOrder` names {repo:?}, which is not a repo of this run ({})", repos_text(repos)));
                    continue;
                };
                if order.contains_key(&spelled) {
                    problems.push(format!("`round.mergeOrder` lists the repo {spelled:?} twice"));
                    continue;
                }
                let ids: Vec<String> = strings(Some(ids), &at, MAX_PLANS, problems).into_iter().map(|id| id.to_lowercase()).collect();
                let mut kept: Vec<String> = Vec::new();
                for id in ids {
                    if kept.contains(&id) {
                        problems.push(format!("`{at}` lists {id} twice"));
                        continue;
                    }
                    match plans.iter().find(|plan| plan.id == id) {
                        None => problems.push(format!("`{at}` names {id:?}, which is not a plan of the round")),
                        Some(plan) if plan.status == PlanStatus::Deferred => {
                            problems.push(format!("`{at}` names {id}, which is deferred: nothing merges from it this round"))
                        }
                        Some(plan) if !plan.repos.iter().any(|r| r == &spelled) => {
                            problems.push(format!("`{at}` names {id}, which does not touch {spelled} (its repos: {})", plan.repos.join(", ")))
                        }
                        Some(_) => kept.push(id),
                    }
                }
                order.insert(spelled, kept);
            }
        }
        Some(other) => {
            problems.push(format!("`round.mergeOrder` must map each repo to its plan ids in merge order, not {other}"));
            return order;
        }
    }
    // Every active plan is in the merge order of each repo it touches.
    for plan in plans.iter().filter(|plan| plan.status == PlanStatus::Active) {
        for repo in &plan.repos {
            if !order.get(repo).is_some_and(|ids| ids.contains(&plan.id)) {
                problems.push(format!("{} touches {repo}, so `round.mergeOrder.{repo}` must list it", plan.id));
            }
        }
    }
    let wave_of = |id: &str| plans.iter().find(|plan| plan.id == id).and_then(|plan| plan.wave);
    // No repo merges a later wave's plan before an earlier wave's.
    for (repo, ids) in &order {
        for (i, earlier) in ids.iter().enumerate() {
            for later in &ids[i + 1..] {
                if let (Some(a), Some(b)) = (wave_of(earlier), wave_of(later)) {
                    if a > b {
                        problems.push(format!(
                            "in {repo}, {earlier} (wave {a}) merges before {later} (wave {b}): a later wave cannot merge before an earlier one"
                        ));
                    }
                }
            }
        }
    }
    if let Some(cycle) = merge_cycle(&order) {
        problems.push(format!("the merge order goes round in a circle across repos ({})", cycle.join(" → ")));
    }
    order
}

/// The first circle in "merges before" across every repo's order, if any.
fn merge_cycle(order: &BTreeMap<String, Vec<String>>) -> Option<Vec<String>> {
    let mut edges: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for ids in order.values() {
        for pair in ids.windows(2) {
            let next = edges.entry(pair[0].as_str()).or_default();
            if !next.contains(&pair[1].as_str()) {
                next.push(pair[1].as_str());
            }
        }
    }
    fn visit<'a>(id: &'a str, edges: &BTreeMap<&'a str, Vec<&'a str>>, path: &mut Vec<&'a str>, done: &mut Vec<&'a str>) -> Option<Vec<String>> {
        if let Some(at) = path.iter().position(|seen| *seen == id) {
            let mut cycle: Vec<String> = path[at..].iter().map(|s| s.to_string()).collect();
            cycle.push(id.to_string());
            return Some(cycle);
        }
        if done.contains(&id) {
            return None;
        }
        path.push(id);
        for next in edges.get(id).map(Vec::as_slice).unwrap_or_default() {
            if let Some(cycle) = visit(next, edges, path, done) {
                return Some(cycle);
            }
        }
        path.pop();
        done.push(id);
        None
    }
    let mut done = Vec::new();
    let starts: Vec<&str> = edges.keys().copied().collect();
    starts.into_iter().find_map(|id| visit(id, &edges, &mut Vec::new(), &mut done))
}

/// Triage's result, as `results/<turn>.json` and the turn event carry it.
pub fn round_result(round: &Round) -> Value {
    let ids = |status: PlanStatus| -> Vec<&str> {
        round.plans.iter().filter(|p| p.status == status).map(|p| p.id.as_str()).collect()
    };
    json!({
        "schema": SCHEMA,
        "round": {
            "active": ids(PlanStatus::Active),
            "deferred": ids(PlanStatus::Deferred),
            "parked": ids(PlanStatus::Parked),
            "waves": round.waves.len(),
        }
    })
}

/// Write `round.md` and `round.json` at the run folder's top.
pub fn write_round(run_dir: &Path, plan: &str, round: &RunRound) -> io::Result<()> {
    write_atomic(&run_dir.join(ROUND_MD_FILE), plan.as_bytes())?;
    write_json(&run_dir.join(ROUND_FILE), round)
}

/// The run's `round.json`, when Triage handed a round over.
pub fn read_round(run_dir: &Path) -> Option<RunRound> {
    read_json(&run_dir.join(ROUND_FILE))
}

/// The deny reason when the round block has problems.
pub fn round_rejected_message(problems: &[String]) -> String {
    let lines: Vec<String> = problems.iter().map(|p| format!("- {p}")).collect();
    format!(
        "DCTerminal did not take this round. Fix each problem in the plan's ```json round block, then call ExitPlanMode again with the whole plan:\n{}\n{}",
        lines.join("\n"),
        ROUND_EXAMPLE
    )
}

/// A small round, for the instructions and the deny reason.
pub const ROUND_EXAMPLE: &str = "Example: ```json\n{\"round\": {\"plans\": [\
{\"id\": \"plan1\", \"title\": \"Session expiry\", \"tickets\": [\"QA-101\"], \"repos\": [\"backend\"], \"status\": \"active\", \"wave\": 1, \"summary\": \"Expire idle sessions server-side.\"}, \
{\"id\": \"plan2\", \"title\": \"Expiry banner\", \"tickets\": [\"QA-102\", \"QA-103\"], \"repos\": [\"backend\", \"web\"], \"status\": \"active\", \"wave\": 2, \"summary\": \"Add the expiry field, then show it.\"}, \
{\"id\": \"plan3\", \"title\": \"CDN cache\", \"tickets\": [\"QA-104\"], \"repos\": [\"cdn\"], \"status\": \"deferred\", \"reason\": \"The fix is in the CDN config, not our repos.\", \"summary\": \"Ask the platform team.\"}], \
\"waves\": [{\"n\": 1, \"why\": \"Isolated backend fix first\"}, {\"n\": 2, \"why\": \"Needs plan1's endpoint\"}], \
\"mergeOrder\": {\"backend\": [\"plan1\", \"plan2\"], \"web\": [\"plan2\"]}, \
\"excluded\": [{\"ticket\": \"QA-105\", \"reason\": \"Already fixed on staging.\"}]}}\n```";

/// What `{{result_instructions}}` becomes on a Triage stage (R1).
pub fn round_instructions(repos: &[crate::store::RepoEntry]) -> String {
    let repo_lines = if repos.is_empty() {
        "No repos are set up in DCTerminal (Settings › Repos): leave `repos` empty (`[]`) for a plan in this run's own folder, and leave `mergeOrder` out.".to_string()
    } else {
        let lines: Vec<String> = repos.iter().map(|repo| format!("- `{}`: {}", repo.name, repo.folder)).collect();
        format!("These repos are set up in DCTerminal (Settings › Repos); a plan's `repos` and `mergeOrder` use their names:\n\n{}", lines.join("\n"))
    };
    format!(
        "## Hand your round to DCTerminal\n\n\
         This stage runs in a DCTerminal pipeline. Hand the round over by calling `ExitPlanMode` with the whole round document. \
         End it with one fenced ```json block holding `round`:\n\n\
         - `plans` (1 to {MAX_PLANS}): each with `id` (`plan1`, `plan2`, …), `title`, `tickets` (ticket ids from tickets.json), `repos` (the repos the plan's \
         pull requests go to, one per repo), `status` (`active`, `deferred` when the fix is outside our repos, `parked` when it waits on a product decision), \
         `reason` (for deferred and parked plans), `wave` (1, 2, …; every active plan has one) and `summary`.\n\
         - `waves`: each with `n` (1, 2, … with no gap) and `why` its plans go together.\n\
         - `mergeOrder`: for each repo, the plan ids in the order their pull requests merge. List every active plan of the repo, and never put a later wave's plan before an earlier wave's.\n\
         - `excluded`: each ticket you leave out of every plan, with its `reason`.\n\n\
         Every ticket of tickets.json goes in exactly one plan or in `excluded`. {ROUND_EXAMPLE}\n\n\
         {repo_lines}\n\n\
         DCTerminal answers ExitPlanMode with \"Plan received\": stop there and end your turn with a short summary; do not start fixing anything. \
         If it answers with problems instead, fix each one and call ExitPlanMode again."
    )
}

/// The Stop hook's block reason on a Triage stage.
pub fn round_block_reason() -> String {
    "You have not handed your round to DCTerminal yet. Call the `ExitPlanMode` tool now with your whole round document, \
     ending with one ```json block: {\"round\": {\"plans\": [{\"id\": \"plan1\", \"title\": \"…\", \"tickets\": [\"…\"], \"repos\": [\"…\"], \
     \"status\": \"active\", \"wave\": 1, \"summary\": \"…\"}], \"waves\": [{\"n\": 1, \"why\": \"…\"}], \"mergeOrder\": {\"…\": [\"plan1\"]}, \"excluded\": []}}. \
     Do not ask the user and do not start fixing anything; then finish your turn."
        .to_string()
}
