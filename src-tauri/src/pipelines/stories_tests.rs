//! L3: the story records, the prompts, and `decide` for a story's turn:
//! the next story, a retry for the same story, a checkpoint story that
//! waits for your Continue, and the last story going on to the PR gates and
//! the PR Reviewer.

use super::*;
use crate::bridge::folder::PlannedStory;
use crate::pipelines::autopilot::{decide, stage_key, TurnReport, MAX_GATE_RETRIES};
use crate::pipelines::{find, GateResult, PipelineDef};
use crate::store::{RunStatus, StageGates, StopReason};
use serde_json::json;

fn eagle1() -> PipelineDef {
    find("eagle1").expect("Eagle-Eye 1")
}

/// An Eagle-Eye 1 run at its Implementer with autopilot on; with `lane`,
/// fanned out with that lane (in the `engine` repo) and one more.
fn run(lane: Option<&str>) -> PipelineRun {
    let mut value = json!({
        "id": "ee_s", "kind": "full", "cwd": "/repo", "stage": "implementer", "tabIds": {},
        "createdAt": "2026-10-22T00:00:00Z", "chainId": "ee_s", "status": "running", "engine": 2,
        "autopilot": { "enabled": true, "passedCheckpoints": ["implementer"] }
    });
    if let Some(lane) = lane {
        value["fanOutStage"] = json!("implementer");
        value["lanes"] = json!([
            { "id": lane, "title": "PR1 — Engine fixes", "status": "active", "stage": "implementer", "round": 1, "tabIds": {}, "repo": "engine" },
            { "id": "pr9", "title": "PR9 — Other", "status": "waiting", "stage": "implementer", "round": 1, "tabIds": {}, "dependsOn": [lane] }
        ]);
    }
    serde_json::from_value(value).expect("a run")
}

fn story(id: &str, title: &str) -> PlannedStory {
    PlannedStory { id: id.into(), title: title.into(), ..PlannedStory::default() }
}

/// Plan 5's task: R5 instrumentation (a checkpoint), then the three T14 fixes.
fn plan5(checkpoint: bool) -> PlannedTask {
    let mut r5 = story("s1", "R5 instrumentation");
    r5.tickets = vec!["86c0r5".into()];
    if checkpoint {
        r5.checkpoint = Some("Rerun the 7,839-file case on Windows and read the log".into());
    }
    let mut dedupe = story("s2", "T14-4 log dedupe");
    dedupe.done_when = vec!["Each line is written once".into()];
    dedupe.planned_tests = vec!["TestLogDedupe".into()];
    PlannedTask {
        id: "pr1".into(),
        title: "Engine fixes".into(),
        depends_on: vec![],
        manual: false,
        summary: "R5 and the T14 fixes.".into(),
        repo: None,
        stories: vec![r5, dedupe, story("s3", "T14-2 lock-file filter"), story("s4", "T14-1 folder name")],
    }
}

fn statuses(run: &PipelineRun, lane: Option<&str>) -> Vec<(String, StoryStatus)> {
    of_lane(run, lane).iter().map(|s| (s.id.clone(), s.status)).collect()
}

fn gate(label: &str, status: &str) -> GateResult {
    GateResult {
        kind: "command".into(),
        label: label.into(),
        status: status.into(),
        summary: if status == "failed" { "Exited with code 1." } else { "Passed." }.into(),
        output: if status == "failed" { "FAIL TestLogDedupe".into() } else { String::new() },
        duration_ms: 5,
        optional: false,
    }
}

/// The story's turn, its checks recorded as the actor records them.
fn story_turn(run: &mut PipelineRun, lane: Option<&str>, id: &str, turn: &str, check: &str) -> TurnReport {
    run.gates.insert(
        stage_key("implementer", lane),
        StageGates { round: 1, at: "now".into(), results: vec![gate("go test ./...", check)] },
    );
    TurnReport {
        stage_id: "implementer".into(),
        lane: lane.map(str::to_string),
        round: Some(1),
        turn: Some(turn.into()),
        findings_known: true,
        story: Some(id.into()),
        summary: Some(format!("{id} is built.")),
        ..TurnReport::default()
    }
}

#[test]
fn a_task_with_stories_is_recorded_once_with_the_first_active() {
    let mut r = run(None);
    assert!(seed(&mut r, None, &plan5(true)));
    assert!(!seed(&mut r, None, &plan5(true)), "seeded once");
    let plain = PlannedTask { stories: vec![], ..plan5(true) };
    assert!(!seed(&mut run(None), None, &plain), "a task without stories records nothing");
    assert_eq!(
        statuses(&r, None),
        [("s1".to_string(), StoryStatus::Active), ("s2".into(), StoryStatus::Pending), ("s3".into(), StoryStatus::Pending), ("s4".into(), StoryStatus::Pending)]
    );
    assert_eq!(r.stories[0].task, "pr1");
    assert_eq!(r.stories[0].tickets, ["86c0r5"]);
    let seeded = mark(&r, None).expect("a story mark");
    assert_eq!((seeded.current.as_deref(), seeded.current_title.as_str()), (Some("s1"), "R5 instrumentation"));
    assert_eq!(seeded.ids, ["s1", "s2", "s3", "s4"]);
    assert!(mark(&run(None), None).is_none());
    // Saved camelCase, with serde defaults for an older reader.
    let saved = serde_json::to_value(&r.stories[1]).unwrap();
    assert_eq!(saved["status"], "pending");
    assert_eq!(saved["plannedTests"][0], "TestLogDedupe");
    let back: crate::store::RunStory = serde_json::from_value(json!({ "id": "s1", "title": "T" })).unwrap();
    assert_eq!((back.status, back.attempt, back.lane), (StoryStatus::Pending, 0, None));
}

#[test]
fn the_first_prompt_lists_every_story_then_asks_for_the_first() {
    let mut r = run(None);
    seed(&mut r, None, &plan5(true));
    let text = first_prompt(&r, None);
    assert!(text.starts_with("## Stories"), "{text}");
    assert!(text.contains("This pull request (PR1) is built in 4 stories"), "{text}");
    assert!(text.contains("1. s1: R5 instrumentation\n   Tickets: 86c0r5\n   Checkpoint (the run waits for the user after this story): Rerun"), "{text}");
    assert!(text.contains("2. s2: T14-4 log dedupe\n   Done when:\n   - Each line is written once\n   Planned tests:\n   - TestLogDedupe"), "{text}");
    assert!(text.contains("Do story s1 now (1 of 4), and only that story."), "{text}");
    assert!(text.contains("`\"story\": \"s1\"`") && text.contains("until the last story (s4)"), "{text}");
    assert!(first_prompt(&run(None), None).is_empty(), "no stories, no section");
    // A new terminal mid-loop starts at the current story.
    r.stories[0].status = StoryStatus::Done;
    r.stories[1].status = StoryStatus::Active;
    let later = first_prompt(&r, None);
    assert!(later.contains("Stories s1 are done already. Do story s2 now (2 of 4)"), "{later}");
}

#[test]
fn a_story_whose_checks_pass_sends_the_next_story_to_the_same_stage() {
    let def = eagle1();
    let mut r = run(Some("pr1"));
    seed(&mut r, Some("pr1"), &plan5(false));
    let report = story_turn(&mut r, Some("pr1"), "s1", "tab|bridge|t1", "passed");
    let d = decide(&def, &mut r, &report);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref(), d.lane.as_deref()), ("nextStory", Some("implementer"), Some("pr1")), "{d:?}");
    assert!(d.reason.contains("Story s1 (1 of 4) passed its checks; story s2 (2 of 4) goes to Implementer."), "{}", d.reason);
    let message = d.message.expect("the next story's prompt");
    assert!(message.starts_with("Story 2 of 4: T14-4 log dedupe\n   Done when:"), "{message}");
    assert!(message.contains("Do story s2 now, on the same branch") && message.contains("`\"story\": \"s2\"`"), "{message}");
    assert_eq!(statuses(&r, Some("pr1"))[..2], [("s1".to_string(), StoryStatus::Done), ("s2".into(), StoryStatus::Active)]);
    let done = &r.stories[0];
    assert_eq!((done.summary.as_deref(), done.turn.as_deref()), (Some("s1 is built."), Some("tab|bridge|t1")));
    assert_eq!(r.status, RunStatus::Running);
    assert_eq!(r.events.last().and_then(|e| e.outcome.as_deref()), Some("nextStory"));
    assert_eq!(r.events.last().and_then(|e| e.lane_id.as_deref()), Some("pr1"));
    // The same turn read again changes nothing.
    assert_eq!(decide(&def, &mut r, &report).action, "ignore");
}

#[test]
fn a_failed_story_check_goes_back_for_the_same_story_under_the_retry_limit() {
    let def = eagle1();
    let mut r = run(None);
    seed(&mut r, None, &plan5(false));
    r.stories[0].status = StoryStatus::Done;
    r.stories[1].status = StoryStatus::Active;
    let report = story_turn(&mut r, None, "s2", "t-1", "failed");
    let d = decide(&def, &mut r, &report);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("retry", Some("implementer")));
    let message = d.message.unwrap();
    assert!(message.contains("FAIL TestLogDedupe"), "{message}");
    assert!(message.ends_with("This is still story s2 (2 of 4): once it is fixed, call `submit_result` with `\"story\": \"s2\"` again."), "{message}");
    assert_eq!((r.stories[1].status, r.stories[1].attempt), (StoryStatus::Failed, 1));
    // The fix passes: on to s3, and the retries start over for it.
    let report = story_turn(&mut r, None, "s2", "t-2", "passed");
    assert_eq!(decide(&def, &mut r, &report).action, "nextStory");
    assert_eq!(statuses(&r, None)[1..3], [("s2".to_string(), StoryStatus::Done), ("s3".into(), StoryStatus::Active)]);
    assert!(r.autopilot.as_ref().unwrap().gate_retries.is_empty());
    // A check that keeps failing still stops with gate_failed.
    for n in 0..=MAX_GATE_RETRIES {
        let report = story_turn(&mut r, None, "s3", &format!("t-3-{n}"), "failed");
        decide(&def, &mut r, &report);
    }
    assert_eq!((r.status, r.stop_reason), (RunStatus::Waiting, Some(StopReason::GateFailed)));
    assert_eq!((r.stories[2].status, r.stories[2].attempt), (StoryStatus::Failed, MAX_GATE_RETRIES + 1));
}

#[test]
fn a_checkpoint_story_waits_for_you_and_continue_passes_your_note_on() {
    let def = eagle1();
    let mut r = run(None);
    seed(&mut r, None, &plan5(true));
    let report = story_turn(&mut r, None, "s1", "tab|bridge|t1", "passed");
    let d = decide(&def, &mut r, &report);
    assert_eq!((d.action.as_str(), d.stop_reason), ("stop", Some(StopReason::Checkpoint)), "{d:?}");
    assert!(d.reason.contains("story s1 (1 of 4) passed its checks, and its checkpoint waits for you: Rerun the 7,839-file case"), "{}", d.reason);
    assert_eq!((r.status, r.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)));
    let wait = r.autopilot.as_ref().unwrap().story_wait.clone().expect("the story wait");
    assert_eq!((wait.story.as_str(), wait.lane.as_deref(), wait.turn.as_deref()), ("s1", None, Some("tab|bridge|t1")));
    assert!(r.autopilot.as_ref().unwrap().verify.is_none());
    assert_eq!(r.stories[0].status, StoryStatus::Waiting);
    assert_eq!(mark(&r, None).unwrap().current.as_deref(), Some("s1"), "still s1 until you continue");
    // A Continue for another story, or with too long a note, changes nothing.
    assert!(continue_after(&mut r.clone(), None, "s2", None, &[]).is_err());
    let long = "x".repeat(MAX_STORY_NOTE_CHARS + 1);
    assert!(continue_after(&mut r.clone(), None, "s1", Some(&long), &[]).unwrap_err().contains("longer than"));
    // Continue with your finding, adding a story right after s1.
    let note = "R5 log: the scan stalls 40 s on the lock file before the first walk.";
    let added = parse_added("- Skip the lock file before the walk\n\n");
    assert_eq!(added, ["Skip the lock file before the walk"]);
    let next = continue_after(&mut r, None, "s1", Some(note), &added).expect("continued");
    assert_eq!(next, "s5");
    let order: Vec<(String, StoryStatus, bool)> = of_lane(&r, None).iter().map(|s| (s.id.clone(), s.status, s.added)).collect();
    assert_eq!(
        order,
        [
            ("s1".to_string(), StoryStatus::Done, false),
            ("s5".into(), StoryStatus::Active, true),
            ("s2".into(), StoryStatus::Pending, false),
            ("s3".into(), StoryStatus::Pending, false),
            ("s4".into(), StoryStatus::Pending, false),
        ]
    );
    assert_eq!(r.stories[0].note.as_deref(), Some(note));
    let message = story_message(&r, None, "s5");
    assert!(message.starts_with("Story 2 of 5: Skip the lock file before the walk"), "{message}");
    assert!(message.contains(&format!("The user's finding from the checkpoint after story s1 (Rerun the 7,839-file case on Windows and read the log): {note}")), "{message}");
    // Twenty stories at most, counting the ones you add.
    let mut waiting = run(None);
    seed(&mut waiting, None, &plan5(true));
    let report = story_turn(&mut waiting, None, "s1", "t-full", "passed");
    assert_eq!(decide(&def, &mut waiting, &report).stop_reason, Some(StopReason::Checkpoint));
    let many: Vec<String> = (0..17).map(|n| format!("Extra {n}")).collect();
    assert!(continue_after(&mut waiting.clone(), None, "s1", None, &many).unwrap_err().contains("limit of 20"));
}

#[test]
fn the_last_story_runs_every_gate_and_goes_on_to_the_pr_reviewer() {
    let def = eagle1();
    let mut r = run(None);
    seed(&mut r, None, &plan5(false));
    for story in r.stories.iter_mut().take(3) {
        story.status = StoryStatus::Done;
    }
    r.stories[3].status = StoryStatus::Active;
    assert!(!before_last(&r, None, "s3") && !before_last(&r, None, "s4"), "s4 is the last: every gate runs");
    let report = story_turn(&mut r, None, "s4", "t-4", "passed");
    let d = decide(&def, &mut r, &report);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("advance", Some("pr_reviewer")), "{d:?}");
    assert!(of_lane(&r, None).iter().all(|s| s.status == StoryStatus::Done));
    assert_eq!(mark(&r, None).unwrap().current, None, "a review round reports no story");
    // A later Implementer turn with no story (a review round) is not stopped as off the loop.
    let mut round = r.clone();
    let plain = TurnReport { story: None, turn: Some("t-5".into()), ..report.clone() };
    assert_ne!(decide(&def, &mut round, &plain).action, "stop");
}

#[test]
fn a_turn_that_names_no_current_story_mid_loop_stops_instead_of_handing_on() {
    let def = eagle1();
    let mut r = run(None);
    seed(&mut r, None, &plan5(false));
    let mut report = story_turn(&mut r, None, "s3", "t-x", "passed");
    let d = decide(&def, &mut r, &report);
    assert_eq!((d.action.as_str(), d.stop_reason), ("stop", Some(StopReason::NoResult)), "{d:?}");
    assert!(d.reason.contains("reported story s3, but its pull request is on story s1 (R5 instrumentation)"), "{}", d.reason);
    let mut r = run(None);
    seed(&mut r, None, &plan5(false));
    report.story = None;
    report.turn = Some("t-y".into());
    assert!(decide(&def, &mut r, &report).reason.contains("reported no story"));
    // Before the loop starts (no records) a plain Implementer turn is as before.
    let mut plain = run(None);
    assert_eq!(decide(&def, &mut plain, &report).action, "advance");
}

#[test]
fn added_stories_drop_only_list_markers() {
    let added = parse_added("- One\n* Two\n• Three\n1. Four\n12) Five\n-flag stays\n2024 plan\n**bold**\n\n");
    assert_eq!(added, ["One", "Two", "Three", "Four", "Five", "-flag stays", "2024 plan", "**bold**"]);
}

#[test]
fn skipped_stories_end_the_loop_and_a_story_left_checking_is_active_again() {
    let mut r = run(None);
    seed(&mut r, None, &plan5(false));
    assert!(mid_loop(&r, None), "s1 of 4: command checks only");
    set_status(&mut r, None, "s1", StoryStatus::Checking);
    settle_checking(&mut r, None);
    assert_eq!(r.stories[0].status, StoryStatus::Active);
    r.stories[0].status = StoryStatus::Done;
    assert_eq!(skip_unfinished(&mut r, None), ["s2", "s3", "s4"]);
    assert!(current(&r, None).is_none() && !mid_loop(&r, None));
    assert_eq!(mark(&r, None).unwrap().current, None);
    assert!(skip_unfinished(&mut r, None).is_empty());
    assert!(resend(&mut r, None, "implementer").unwrap_err().contains("finished"));
}

#[test]
fn resend_makes_the_current_story_active_with_its_retries_started_over() {
    let mut r = run(None);
    seed(&mut r, None, &plan5(true));
    set_failed(&mut r, None, "s1", 3);
    r.autopilot.as_mut().unwrap().gate_retries.insert("implementer".into(), 2);
    assert_eq!(resend(&mut r, None, "implementer").unwrap(), "s1");
    assert_eq!(r.stories[0].status, StoryStatus::Active);
    assert!(r.autopilot.as_ref().unwrap().gate_retries.is_empty());
    r.stories[0].status = StoryStatus::Waiting;
    assert!(resend(&mut r, None, "implementer").unwrap_err().contains("press Continue"));
}

#[test]
fn continue_takes_a_waiting_story_even_after_the_runs_wait_ended() {
    let def = eagle1();
    let mut r = run(None);
    seed(&mut r, None, &plan5(true));
    let report = story_turn(&mut r, None, "s1", "t-1", "passed");
    decide(&def, &mut r, &report);
    r.set_autopilot_enabled(false);
    r.set_autopilot_enabled(true);
    assert!(r.autopilot.as_ref().unwrap().story_wait.is_none());
    assert_eq!(continue_after(&mut r, None, "s1", Some("ok"), &[]).unwrap(), "s2");
}
