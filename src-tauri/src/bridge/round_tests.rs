//! R1: the Triage round check. The fixture has the shape of a real QA
//! round (8 plans in 4 waves across 4 repos, one deferred plan, one parked
//! plan, per-repo merge orders) with invented tickets.

use super::round::{triage_round, KnownTicket, PlanStatus, Round, MAX_PLANS};
use serde_json::{json, Value};

const REPOS: [&str; 4] = ["backend", "engine", "desktop", "web"];

fn repos() -> Vec<String> {
    REPOS.iter().map(|r| r.to_string()).collect()
}

/// QA-201 … QA-222; QA-209 also has a custom id.
fn tickets() -> Vec<KnownTicket> {
    (201..=222)
        .map(|n| KnownTicket {
            id: format!("QA-{n}"),
            custom_id: (n == 209).then(|| "ENG-9".to_string()),
        })
        .collect()
}

fn plan(id: &str, title: &str, tickets: &[&str], repos: &[&str], status: &str, wave: Option<u32>) -> Value {
    let mut plan = json!({
        "id": id, "title": title, "tickets": tickets, "repos": repos, "status": status,
        "summary": format!("{title}: fix and verify.")
    });
    if let Some(wave) = wave {
        plan["wave"] = json!(wave);
    }
    if status != "active" {
        plan["reason"] = json!(format!("{title} is {status} for now."));
    }
    plan
}

/// 8 plans, 4 waves: plans 5 and 1 first, the strings sweep (plan 7) last,
/// plan 3 parked in wave 3, plan 8 deferred (its fix is in a gateway).
fn example() -> Value {
    json!({ "round": {
        "plans": [
            plan("plan1", "Session expiry", &["QA-201"], &["Backend"], "active", Some(1)),
            plan("plan2", "Device heartbeat", &["QA-202"], &["backend", "engine"], "active", Some(2)),
            plan("plan3", "File timestamps", &["QA-203", "QA-204"], &["backend", "engine"], "parked", Some(3)),
            plan("plan4", "Approval list", &["QA-205", "QA-206", "QA-207", "QA-208"], &["backend", "desktop", "web"], "active", Some(2)),
            plan("plan5", "Engine queue", &["ENG-9", "QA-210", "QA-211", "QA-212"], &["engine"], "active", Some(1)),
            plan("plan6", "Desktop crashes", &["QA-213", "QA-214", "QA-215"], &["desktop"], "active", Some(3)),
            plan("plan7", "Copy sweep", &["QA-216", "QA-217", "QA-218", "QA-219", "QA-220"], &["desktop", "web"], "active", Some(4)),
            plan("plan8", "Gateway throughput", &["QA-221"], &["gateway", "backend"], "deferred", None),
        ],
        "waves": [
            { "n": 1, "why": "Isolated: data loss and billing first" },
            { "n": 2, "why": "New endpoints and fields" },
            { "n": 3, "why": "Builds on waves 1 and 2" },
            { "n": 4, "why": "Locale files clash: one rebase at the end" },
        ],
        "mergeOrder": {
            "backend": ["plan1", "plan2", "plan4", "plan3"],
            "engine": ["plan5", "plan2", "plan3"],
            "desktop": ["plan4", "plan6", "plan7"],
            "web": ["plan4", "plan7"],
        },
        "excluded": [{ "ticket": "QA-222", "reason": "Already fixed on staging." }],
    } })
}

fn doc(block: &Value) -> String {
    format!("# QA round\n\n## 1. Summary\n22 tickets, 8 plans.\n\n```json\n{block}\n```\n")
}

fn check(block: &Value) -> Result<Round, Vec<String>> {
    triage_round(&doc(block), &repos(), Some(&tickets()))
}

fn problems(block: &Value) -> Vec<String> {
    check(block).expect_err("rejected")
}

fn has(problems: &[String], needle: &str) -> bool {
    problems.iter().any(|p| p.contains(needle))
}

#[test]
fn a_round_shaped_like_a_real_qa_round_is_accepted() {
    let round = check(&example()).expect("valid round");
    assert_eq!(round.plans.len(), 8);
    assert_eq!(round.waves.iter().map(|w| w.n).collect::<Vec<_>>(), [1, 2, 3, 4]);
    let statuses: Vec<PlanStatus> = round.plans.iter().map(|p| p.status).collect();
    assert_eq!(statuses.iter().filter(|s| **s == PlanStatus::Active).count(), 6);
    assert_eq!(round.plan("plan3").unwrap().status, PlanStatus::Parked);
    let deferred = round.plan("plan8").unwrap();
    assert_eq!((deferred.status, deferred.wave), (PlanStatus::Deferred, None));
    // A deferred plan's fix is outside our repos: its repos are kept, not checked.
    assert_eq!(deferred.repos, ["gateway", "backend"]);
    // Repos are spelled as Settings spells them.
    assert_eq!(round.plan("plan1").unwrap().repos, ["backend"]);
    assert_eq!(round.merge_order["backend"], ["plan1", "plan2", "plan4", "plan3"]);
    assert_eq!(round.merge_order["engine"], ["plan5", "plan2", "plan3"]);
    assert_eq!(round.merge_order["desktop"], ["plan4", "plan6", "plan7"]);
    assert_eq!(round.merge_order["web"], ["plan4", "plan7"]);
    assert_eq!(round.excluded[0].ticket, "QA-222");
    // A plan may name a ticket by its custom id.
    assert_eq!(round.plan("plan5").unwrap().tickets[0], "ENG-9");
    // The written file reads back the same.
    let text = serde_json::to_string(&round).unwrap();
    assert_eq!(serde_json::from_str::<Round>(&text).unwrap(), round);
}

#[test]
fn a_dictated_round_has_no_tickets_json_to_check_against() {
    let mut block = example();
    block["round"]["plans"][0]["tickets"] = json!(["T1"]);
    block["round"]["excluded"] = json!([]);
    assert!(triage_round(&doc(&block), &repos(), None).is_ok());
}

#[test]
fn a_plan_with_no_round_block_or_bad_json_is_refused() {
    let none = triage_round("# Round\nNo block.", &repos(), None).unwrap_err();
    assert!(has(&none, "no ```json block with `round`"), "{none:?}");
    let bad = triage_round("```json\n{\"round\": [\n```", &repos(), None).unwrap_err();
    assert!(has(&bad, "not valid JSON"), "{bad:?}");
    let schema = problems(&json!({ "schema": 2, "round": example()["round"] }));
    assert!(has(&schema, "`schema` must be 1"), "{schema:?}");
    assert!(has(&triage_round("", &repos(), None).unwrap_err(), "empty"));
}

#[test]
fn every_ticket_is_in_exactly_one_plan_or_excluded() {
    let mut missing = example();
    missing["round"]["excluded"] = json!([]);
    let found = problems(&missing);
    assert!(has(&found, "in neither: QA-222"), "{found:?}");

    let mut twice = example();
    twice["round"]["plans"][0]["tickets"] = json!(["QA-201", "QA-202"]);
    let found = problems(&twice);
    assert!(has(&found, "ticket QA-202 is in plan1 and plan2"), "{found:?}");

    let mut also_excluded = example();
    also_excluded["round"]["excluded"] = json!([
        { "ticket": "QA-222", "reason": "Done." },
        { "ticket": "qa-201", "reason": "Duplicate." }
    ]);
    let found = problems(&also_excluded);
    assert!(has(&found, "ticket QA-201 is in plan1 and excluded"), "{found:?}");

    let mut unknown = example();
    unknown["round"]["plans"][0]["tickets"] = json!(["QA-201", "QA-999"]);
    let found = problems(&unknown);
    assert!(has(&found, "\"QA-999\" is not a ticket of this run's tickets.json"), "{found:?}");
}

#[test]
fn plan_repos_must_be_repos_of_the_run() {
    let mut block = example();
    block["round"]["plans"][5]["repos"] = json!(["desktop", "mobile"]);
    let found = problems(&block);
    assert!(has(&found, "\"mobile\" is not a repo of this run (the repos are backend, engine, desktop, web)"), "{found:?}");
    // With no repos set up, a plan names none (the run's own folder).
    let mut home = json!({ "round": {
        "plans": [plan("plan1", "Fix", &["QA-1"], &[], "active", Some(1))],
        "waves": [{ "n": 1, "why": "Only wave" }]
    } });
    assert!(triage_round(&doc(&home), &[], None).is_ok());
    home["round"]["plans"][0]["repos"] = json!(["backend"]);
    let found = triage_round(&doc(&home), &[], None).unwrap_err();
    assert!(has(&found, "none are set up"), "{found:?}");
}

#[test]
fn waves_run_from_one_with_no_gap_and_every_active_plan_has_one() {
    let mut gap = example();
    gap["round"]["waves"][1]["n"] = json!(5);
    let found = problems(&gap);
    assert!(has(&found, "wave 2 is missing"), "{found:?}");
    assert!(has(&found, "plan2 is in wave 2, which is not in `round.waves`"), "{found:?}");

    let mut no_wave = example();
    no_wave["round"]["plans"][5].as_object_mut().unwrap().remove("wave");
    let found = problems(&no_wave);
    assert!(has(&found, "plan6 is active, so it needs a `wave`"), "{found:?}");

    let mut empty_wave = example();
    empty_wave["round"]["waves"].as_array_mut().unwrap().push(json!({ "n": 5, "why": "Nothing" }));
    assert!(has(&problems(&empty_wave), "wave 5 has no plan"));

    let mut twice = example();
    twice["round"]["waves"][3]["n"] = json!(3);
    assert!(has(&problems(&twice), "wave 3 is listed twice"));
}

#[test]
fn deferred_and_parked_plans_say_why() {
    let mut block = example();
    block["round"]["plans"][7].as_object_mut().unwrap().remove("reason");
    block["round"]["plans"][2].as_object_mut().unwrap().remove("reason");
    let found = problems(&block);
    assert!(has(&found, "plan8 is deferred, so it needs a `reason`"), "{found:?}");
    assert!(has(&found, "plan3 is parked, so it needs a `reason`"), "{found:?}");
    let mut status = example();
    status["round"]["plans"][0]["status"] = json!("later");
    assert!(has(&problems(&status), "`round.plans[0].status` must be"));
}

#[test]
fn the_merge_order_names_only_plans_of_that_repo_and_lists_every_active_one() {
    let mut other_repo = example();
    other_repo["round"]["mergeOrder"]["web"] = json!(["plan4", "plan6", "plan7"]);
    let found = problems(&other_repo);
    assert!(has(&found, "names plan6, which does not touch web"), "{found:?}");

    let mut deferred = example();
    deferred["round"]["mergeOrder"]["backend"] = json!(["plan1", "plan2", "plan4", "plan3", "plan8"]);
    assert!(has(&problems(&deferred), "names plan8, which is deferred"));

    let mut missing = example();
    missing["round"]["mergeOrder"]["desktop"] = json!(["plan4", "plan7"]);
    assert!(has(&problems(&missing), "plan6 touches desktop, so `round.mergeOrder.desktop` must list it"));

    let mut unknown = example();
    unknown["round"]["mergeOrder"]["mobile"] = json!(["plan1"]);
    assert!(has(&problems(&unknown), "`round.mergeOrder` names \"mobile\""));

    let mut not_a_plan = example();
    not_a_plan["round"]["mergeOrder"]["web"] = json!(["plan4", "plan7", "plan9"]);
    assert!(has(&problems(&not_a_plan), "names \"plan9\", which is not a plan"));
}

#[test]
fn the_merge_order_cannot_contradict_the_waves() {
    let mut block = example();
    // Plan 4 (wave 2) before plan 1 (wave 1) in backend.
    block["round"]["mergeOrder"]["backend"] = json!(["plan4", "plan1", "plan2", "plan3"]);
    let found = problems(&block);
    assert!(
        has(&found, "in backend, plan4 (wave 2) merges before plan1 (wave 1): a later wave cannot merge before an earlier one"),
        "{found:?}"
    );
}

#[test]
fn a_merge_order_that_goes_round_in_a_circle_is_refused() {
    // Same wave, so no wave contradiction: backend says 1 then 2, engine 2 then 1.
    let block = json!({ "round": {
        "plans": [
            plan("plan1", "Contract A", &["QA-201"], &["backend", "engine"], "active", Some(1)),
            plan("plan2", "Contract B", &["QA-202"], &["backend", "engine"], "active", Some(1)),
        ],
        "waves": [{ "n": 1, "why": "Both at once" }],
        "mergeOrder": { "backend": ["plan1", "plan2"], "engine": ["plan2", "plan1"] }
    } });
    let found = triage_round(&doc(&block), &repos(), None).unwrap_err();
    assert!(has(&found, "goes round in a circle across repos (plan1 → plan2 → plan1)"), "{found:?}");
}

#[test]
fn ids_are_unique_and_a_round_has_at_most_thirty_plans() {
    let mut twice = example();
    twice["round"]["plans"][1]["id"] = json!("plan1");
    let found = problems(&twice);
    assert!(has(&found, "plan id \"plan1\" is used twice"), "{found:?}");

    let mut bad_id = example();
    bad_id["round"]["plans"][0]["id"] = json!("p1");
    assert!(has(&problems(&bad_id), "must be plan1, plan2"));

    let many: Vec<Value> = (1..=MAX_PLANS + 1)
        .map(|n| plan(&format!("plan{n}"), "Fix", &[], &[], "active", Some(1)))
        .map(|mut p| {
            p["tickets"] = json!([format!("T-{}", p["id"].as_str().unwrap_or_default())]);
            p
        })
        .collect();
    let block = json!({ "round": { "plans": many, "waves": [{ "n": 1, "why": "All" }] } });
    let found = triage_round(&doc(&block), &[], None).unwrap_err();
    assert!(has(&found, "has 31 plans; at most 30"), "{found:?}");
}

#[test]
fn every_problem_is_named_at_once() {
    let mut block = example();
    block["round"]["excluded"] = json!([]);
    block["round"]["plans"][7].as_object_mut().unwrap().remove("reason");
    block["round"]["mergeOrder"]["backend"] = json!(["plan4", "plan1", "plan2", "plan3"]);
    block["round"]["plans"][5]["repos"] = json!(["desktop", "mobile"]);
    block["round"]["surprise"] = json!(true);
    let found = problems(&block);
    for needle in ["in neither: QA-222", "plan8 is deferred", "in backend, plan4 (wave 2)", "\"mobile\" is not a repo", "surprise"] {
        assert!(has(&found, needle), "{needle}: {found:?}");
    }
}
