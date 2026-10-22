//! The story loop (L3, decision E7): one pull request per repo per plan,
//! built in stories inside it. A task in `tasks.json` may list `stories[]`;
//! its Implementer works through them in order, in one Claude session and
//! one branch. After each story it calls `submit_result` with `story` set:
//! the lane's command checks run (the repo's check from L2, else the stage's
//! command gates), and once they pass the run actor resumes the session
//! with the next story. A failed check goes back for the same story under
//! the usual retry rule. A story with a `checkpoint` waits for you once its
//! checks pass (`checkpoint`, `autopilot.story_wait`); **Continue** sends
//! the next story with your note, and can add stories after it. Only the
//! last story runs the `pullRequest` and `verify` gates; then the PR
//! Reviewer reviews the whole pull request as before.
//!
//! The run keeps one [`RunStory`] per story (`PipelineRun::stories`); the
//! stage folder's `story.json` ([`StoryMark`]) tells the bridge which story
//! is current, so a result for any other is refused. Everything here is
//! pure over the run and the task; the actor reads and writes the files.

use crate::bridge::folder::{PlannedStory, PlannedTask, StoryMark, SCHEMA};
use crate::store::{PipelineRun, RunStory, StoryStatus, StoryWait};

/// Most stories a pull request has, counting the ones you add (L3).
pub const MAX_STORIES: usize = crate::bridge::schema::MAX_STORIES;
/// Longest note you can pass on at a checkpoint.
pub const MAX_STORY_NOTE_CHARS: usize = 4_000;
/// Longest title of a story you add at a checkpoint.
pub const MAX_ADDED_TITLE_CHARS: usize = 300;

impl RunStory {
    fn from_planned(lane: Option<&str>, task: &str, story: &PlannedStory) -> Self {
        Self {
            lane: lane.map(str::to_string),
            task: task.to_string(),
            id: story.id.clone(),
            title: story.title.clone(),
            tickets: story.tickets.clone(),
            done_when: story.done_when.clone(),
            planned_tests: story.planned_tests.clone(),
            checkpoint: story.checkpoint.clone(),
            ..Self::default()
        }
    }
}

/// The stories of `lane` (`None`: the run's own Implementer), in order.
pub fn of_lane<'a>(run: &'a PipelineRun, lane: Option<&str>) -> Vec<&'a RunStory> {
    run.stories.iter().filter(|story| story.lane.as_deref() == lane).collect()
}

/// The story `lane` is on: the first one not done (or skipped). `None` once
/// every story is finished, or when it has none.
pub fn current<'a>(run: &'a PipelineRun, lane: Option<&str>) -> Option<&'a RunStory> {
    of_lane(run, lane).into_iter().find(|story| !finished(story.status))
}

fn finished(status: StoryStatus) -> bool {
    matches!(status, StoryStatus::Done | StoryStatus::Skipped)
}

/// `lane` is mid-loop: its current story is not its last, so only the
/// command checks apply (the actor's checks and your Run checks alike).
pub fn mid_loop(run: &PipelineRun, lane: Option<&str>) -> bool {
    current(run, lane).is_some_and(|now| before_last(run, lane, &now.id))
}

/// Story `id`, whose own turn's checks were neither passed nor failed (the
/// turn was skipped, held or stopped), is active again; left `checking`
/// only while those checks still run. Any other story is left alone.
pub fn settle_checking(run: &mut PipelineRun, lane: Option<&str>, id: &str) {
    if let Some(story) = story_mut(run, lane, id).filter(|s| s.status == StoryStatus::Checking) {
        story.status = StoryStatus::Active;
        story.at = Some(now());
    }
}

/// The pull request goes on (your hand-on, or your approval) with stories
/// not finished: each is marked skipped, so a later review round is never
/// taken for a story. Returns their ids, for the Timeline line.
pub fn skip_unfinished(run: &mut PipelineRun, lane: Option<&str>) -> Vec<String> {
    let at = now();
    let mut skipped = Vec::new();
    for story in run.stories.iter_mut().filter(|s| s.lane.as_deref() == lane && !finished(s.status)) {
        story.status = StoryStatus::Skipped;
        story.at = Some(at.clone());
        skipped.push(story.id.clone());
    }
    skipped
}

/// **Resend story** (L3): the current story of `lane`, sent again after the
/// run stopped mid-loop. It is active again and its check retries start
/// over. Returns its id; `Err` when there is no story to resend, or it
/// waits on its checkpoint (that is Continue).
pub fn resend(run: &mut PipelineRun, lane: Option<&str>, stage_key: &str) -> Result<String, String> {
    let now_story = current(run, lane).ok_or("Every story of this pull request is finished: there is none to send again.")?;
    if now_story.status == StoryStatus::Waiting {
        return Err(format!("Story {} waits on its checkpoint: press Continue instead.", now_story.id));
    }
    if now_story.status == StoryStatus::Verifying {
        return Err(format!("Story {} waits on your verification: mark it verified or failed instead.", now_story.id));
    }
    let id = now_story.id.clone();
    set_status(run, lane, &id, StoryStatus::Active);
    if let Some(autopilot) = run.autopilot.as_mut() {
        autopilot.gate_retries.remove(stage_key);
    }
    Ok(id)
}

/// `id` is the story `lane` is on now.
pub fn is_current(run: &PipelineRun, lane: Option<&str>, id: &str) -> bool {
    current(run, lane).is_some_and(|story| story.id == id)
}

/// `id` is `lane`'s current story and another comes after it: only the
/// command checks run for its turn, not the pull-request or verify gates.
pub fn before_last(run: &PipelineRun, lane: Option<&str>, id: &str) -> bool {
    let stories = of_lane(run, lane);
    is_current(run, lane, id) && stories.last().is_some_and(|last| last.id != id)
}

/// `id`'s place in `lane` as (1-based number, total).
pub fn position(run: &PipelineRun, lane: Option<&str>, id: &str) -> Option<(usize, usize)> {
    let stories = of_lane(run, lane);
    let at = stories.iter().position(|story| story.id == id)?;
    Some((at + 1, stories.len()))
}

/// Record `task`'s stories for `lane` when the run has none for it yet; the
/// first is active. True when it added them.
pub fn seed(run: &mut PipelineRun, lane: Option<&str>, task: &PlannedTask) -> bool {
    if task.stories.is_empty() || !of_lane(run, lane).is_empty() {
        return false;
    }
    let at = now();
    for (index, story) in task.stories.iter().enumerate() {
        let mut record = RunStory::from_planned(lane, &task.id, story);
        if index == 0 {
            record.status = StoryStatus::Active;
            record.at = Some(at.clone());
        }
        run.stories.push(record);
    }
    true
}

fn story_mut<'a>(run: &'a mut PipelineRun, lane: Option<&str>, id: &str) -> Option<&'a mut RunStory> {
    run.stories.iter_mut().find(|story| story.lane.as_deref() == lane && story.id == id)
}

/// Set `id`'s status (and when).
pub fn set_status(run: &mut PipelineRun, lane: Option<&str>, id: &str, status: StoryStatus) {
    if let Some(story) = story_mut(run, lane, id) {
        story.status = status;
        story.at = Some(now());
    }
}

/// `id`'s checks failed again: its `attempt` is `attempt` now.
pub fn set_failed(run: &mut PipelineRun, lane: Option<&str>, id: &str, attempt: u32) {
    if let Some(story) = story_mut(run, lane, id) {
        story.status = StoryStatus::Failed;
        story.attempt = attempt;
        story.at = Some(now());
    }
}

/// What comes after a story whose checks passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Finished {
    /// The next story (its id) is active now: resume the session with it.
    Next(String),
    /// The story has a checkpoint: the run waits for your Continue.
    Checkpoint(String),
    /// It was the last story: the pull request goes on as before.
    Last,
}

/// `id`'s checks passed for `turn`: it is done (or, with a checkpoint,
/// waiting for you) with the Implementer's `summary`. `None` when `id` is
/// not `lane`'s current story.
pub fn finish(run: &mut PipelineRun, lane: Option<&str>, id: &str, turn: Option<&str>, summary: Option<&str>) -> Option<Finished> {
    if !is_current(run, lane, id) {
        return None;
    }
    let next = {
        let stories = of_lane(run, lane);
        let at = stories.iter().position(|story| story.id == id)?;
        stories.get(at + 1).map(|story| story.id.clone())
    };
    let story = story_mut(run, lane, id)?;
    story.turn = turn.map(|turn| super::verify::plain_turn_key(turn).to_string());
    if let Some(summary) = summary.map(str::trim).filter(|s| !s.is_empty()) {
        story.summary = Some(summary.to_string());
    }
    story.at = Some(now());
    let Some(next) = next else {
        story.status = StoryStatus::Done;
        return Some(Finished::Last);
    };
    if let Some(checkpoint) = story.checkpoint.clone().filter(|c| !c.trim().is_empty()) {
        story.status = StoryStatus::Waiting;
        return Some(Finished::Checkpoint(checkpoint));
    }
    story.status = StoryStatus::Done;
    set_status(run, lane, &next, StoryStatus::Active);
    Some(Finished::Next(next))
}

/// The wait `decide` records for a checkpoint story.
pub fn wait(stage_id: &str, lane: Option<&str>, story: &str, checkpoint: &str, turn: Option<&str>) -> StoryWait {
    StoryWait {
        stage_id: stage_id.to_string(),
        lane: lane.map(str::to_string),
        story: story.to_string(),
        checkpoint: checkpoint.to_string(),
        turn: turn.map(|turn| super::verify::plain_turn_key(turn).to_string()),
        at: now(),
    }
}

/// The story titles you typed to add at a checkpoint, one per line.
/// A list marker (`- `, `* `, `• `, `1. `, `1) `) is dropped; any other
/// leading text, such as `-flag` or `2024 plan`, is kept.
pub fn parse_added(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| strip_marker(line.trim()).trim())
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn strip_marker(line: &str) -> &str {
    for bullet in ["- ", "* ", "• "] {
        if let Some(rest) = line.strip_prefix(bullet) {
            return rest;
        }
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let rest = &line[digits..];
        for end in [". ", ") "] {
            if let Some(rest) = rest.strip_prefix(end) {
                return rest;
            }
        }
    }
    line
}

/// Your **Continue** at `story`'s checkpoint in `lane`: the story is done
/// with your `note`, the `added` stories go right after it, and the next
/// story is active. Returns that story's id. `Err` (nothing changed) when
/// the run does not wait on that checkpoint or the note or stories do not fit.
pub fn continue_after(
    run: &mut PipelineRun,
    lane: Option<&str>,
    story: &str,
    note: Option<&str>,
    added: &[String],
) -> Result<String, String> {
    let waiting = run
        .autopilot
        .as_ref()
        .and_then(|a| a.story_wait.as_ref())
        .is_some_and(|wait| wait.lane.as_deref() == lane && wait.story == story);
    if !waiting || !current(run, lane).is_some_and(|now| now.id == story && now.status == StoryStatus::Waiting) {
        return Err("The run is not waiting on that story's checkpoint any more. Reload the overview.".into());
    }
    let note = note.map(str::trim).filter(|note| !note.is_empty());
    if note.is_some_and(|note| note.chars().count() > MAX_STORY_NOTE_CHARS) {
        return Err(format!("The note is longer than {MAX_STORY_NOTE_CHARS} characters."));
    }
    if let Some(long) = added.iter().find(|title| title.chars().count() > MAX_ADDED_TITLE_CHARS) {
        return Err(format!("The story \"{}…\" is longer than {MAX_ADDED_TITLE_CHARS} characters.", long.chars().take(40).collect::<String>()));
    }
    let count = of_lane(run, lane).len();
    if count + added.len() > MAX_STORIES {
        return Err(format!(
            "This pull request has {count} stories; with {} more it would pass the limit of {MAX_STORIES}.",
            added.len()
        ));
    }
    let at = run
        .stories
        .iter()
        .position(|s| s.lane.as_deref() == lane && s.id == story)
        .ok_or("That story is not on the run.")?;
    let task = run.stories[at].task.clone();
    let mut numbers: Vec<u32> = of_lane(run, lane)
        .iter()
        .filter_map(|s| s.id.strip_prefix('s').and_then(|n| n.parse().ok()))
        .collect();
    numbers.push(0);
    let mut next_number = numbers.into_iter().max().unwrap_or(0) + 1;
    let mut fresh = Vec::new();
    for title in added.iter().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        let mut id = format!("s{next_number}");
        while of_lane(run, lane).iter().any(|s| s.id == id) {
            next_number += 1;
            id = format!("s{next_number}");
        }
        next_number += 1;
        fresh.push(RunStory {
            lane: lane.map(str::to_string),
            task: task.clone(),
            id,
            title: title.to_string(),
            added: true,
            ..RunStory::default()
        });
    }
    let stamp = now();
    {
        let done = &mut run.stories[at];
        done.status = StoryStatus::Done;
        done.note = note.map(str::to_string);
        done.at = Some(stamp);
    }
    for (offset, story) in fresh.into_iter().enumerate() {
        run.stories.insert(at + 1 + offset, story);
    }
    let next = current(run, lane).map(|s| s.id.clone()).ok_or("The checkpoint story was the last one.")?;
    set_status(run, lane, &next, StoryStatus::Active);
    Ok(next)
}

/// `story.json` for `lane`'s stage: its current story, and every id. `None`
/// when `lane` has no stories.
pub fn mark(run: &PipelineRun, lane: Option<&str>) -> Option<StoryMark> {
    let stories = of_lane(run, lane);
    if stories.is_empty() {
        return None;
    }
    let current = current(run, lane);
    Some(StoryMark {
        schema: SCHEMA,
        current: current.map(|s| s.id.clone()),
        current_title: current.map(|s| s.title.clone()).unwrap_or_default(),
        ids: stories.iter().map(|s| s.id.clone()).collect(),
    })
}

/// One story as the Implementer reads it: its title, then its tickets,
/// done-when lines, planned tests and checkpoint, each when it has them.
fn describe(story: &RunStory) -> String {
    let mut lines = vec![format!("{}: {}", story.id, story.title)];
    if !story.tickets.is_empty() {
        lines.push(format!("   Tickets: {}", story.tickets.join(", ")));
    }
    for (label, items) in [("Done when", &story.done_when), ("Planned tests", &story.planned_tests)] {
        if !items.is_empty() {
            lines.push(format!("   {label}:"));
            lines.extend(items.iter().map(|item| format!("   - {item}")));
        }
    }
    if let Some(checkpoint) = story.checkpoint.as_deref() {
        lines.push(format!("   Checkpoint (the run waits for the user after this story): {checkpoint}"));
    }
    lines.join("\n")
}

/// How a story's turn reports, said in each story prompt.
fn report_line(id: &str, last: Option<&str>) -> String {
    match last {
        Some(last) if last != id => format!(
            "When it is done and pushed, call `submit_result` with `\"story\": \"{id}\"` and a `summary` of what this story changed. \
             `prs` may be `[]` until the last story ({last}), which reports the draft pull request as usual."
        ),
        _ => format!(
            "This is the last story: when it is done and pushed, open (or update) the draft pull request, then call `submit_result` \
             with `\"story\": \"{id}\"`, the pull request in `prs` and a `summary`."
        ),
    }
}

/// The stories section of the Implementer's first prompt (L3): the whole
/// list, then the story to do now (the current one, `s1` at the start).
/// Empty when `lane` has no stories.
pub fn first_prompt(run: &PipelineRun, lane: Option<&str>) -> String {
    let stories = of_lane(run, lane);
    let Some(now) = current(run, lane) else {
        return String::new();
    };
    let total = stories.len();
    let number = stories.iter().position(|s| s.id == now.id).map_or(1, |at| at + 1);
    let list: Vec<String> = stories.iter().enumerate().map(|(i, s)| format!("{}. {}", i + 1, describe(s))).collect();
    let done: Vec<&str> = stories.iter().take(number - 1).map(|s| s.id.as_str()).collect();
    let done = if done.is_empty() {
        String::new()
    } else {
        format!("Stories {} are done already. ", done.join(", "))
    };
    let task = stories.first().map(|s| s.task.to_uppercase()).unwrap_or_default();
    format!(
        "## Stories\n\n\
         This pull request ({task}) is built in {total} stories, in order, in this one session and on this one branch. \
         After each story DCTerminal runs the checks; once they pass, the next story comes as your next prompt. \
         Do not start a later story before it is sent.\n\n{}\n\n\
         {done}Do story {} now ({number} of {total}), and only that story. {}",
        list.join("\n"),
        now.id,
        report_line(&now.id, stories.last().map(|s| s.id.as_str()))
    )
}

/// The prompt that resumes the session with story `id` (L3): "Story s2 of
/// 4: …", its details, the note you passed on at the checkpoint before it,
/// and how to report it.
pub fn story_message(run: &PipelineRun, lane: Option<&str>, id: &str) -> String {
    let stories = of_lane(run, lane);
    let Some(at) = stories.iter().position(|s| s.id == id) else {
        return format!("Do story {id} now.");
    };
    let story = stories[at];
    let mut text = format!("Story {} of {}: {}", at + 1, stories.len(), describe(story).split_once(": ").map_or("", |(_, rest)| rest));
    if let Some(before) = at.checked_sub(1).and_then(|i| stories.get(i)) {
        if let Some(note) = before.note.as_deref() {
            text.push_str(&format!(
                "\n\nThe user's finding from the checkpoint after story {} ({}): {}",
                before.id,
                before.checkpoint.as_deref().unwrap_or(&before.title),
                note
            ));
        }
    }
    text.push_str(&format!(
        "\n\nDo story {id} now, on the same branch, and only that story. {}",
        report_line(id, stories.last().map(|s| s.id.as_str()))
    ));
    text
}

/// What a failed check's retry adds for a story's turn.
pub fn retry_note(run: &PipelineRun, lane: Option<&str>, id: &str) -> String {
    let (number, total) = position(run, lane, id).unwrap_or((1, 1));
    format!("\n\nThis is still story {id} ({number} of {total}): once it is fixed, call `submit_result` with `\"story\": \"{id}\"` again.")
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
#[path = "stories_tests.rs"]
mod tests;
