//! F5: search saved chat text (open tabs, closed tabs, and older saved
//! transcripts in app data). Read-only. Matching is case-insensitive and
//! mirrors `src/search/textSearch.ts`, so `occurrence` (the n-th match in a
//! text) points at the same place when the UI jumps to it.

use crate::store::{StateStore, TranscriptFile};
use serde::Serialize;

pub const SNIPPET_RADIUS: usize = 60;
pub const MAX_HITS_PER_SOURCE: usize = 20;
pub const MAX_HITS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextHit {
    /// 0-based index of this match among all matches in the text.
    pub occurrence: usize,
    pub before: String,
    pub matched: String,
    pub after: String,
}

/// `open` (an open tab's saved text), `closed`, or `archived` (no tab).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorySource {
    pub source: String,
    pub tab_id: String,
    pub label: String,
    pub cwd: String,
    pub updated_at: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHit {
    pub source: String,
    pub tab_id: String,
    pub label: String,
    pub cwd: String,
    pub updated_at: Option<String>,
    pub occurrence: usize,
    /// Total matches in this text (more than the hits returned when capped).
    pub total_in_source: usize,
    pub before: String,
    pub matched: String,
    pub after: String,
}

/// Lowercase one char the way JavaScript's `toLowerCase` does for the
/// common cases; multi-char results keep the first char so offsets match.
fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Byte ranges of non-overlapping, case-insensitive matches.
pub fn find_all(text: &str, query: &str) -> Vec<(usize, usize)> {
    let needle: Vec<char> = query.chars().map(fold).collect();
    if needle.is_empty() || needle.iter().all(|c| c.is_whitespace()) {
        return Vec::new();
    }
    let hay: Vec<(usize, char)> = text.char_indices().map(|(i, c)| (i, fold(c))).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        if hay[i..i + needle.len()]
            .iter()
            .zip(&needle)
            .all(|((_, a), b)| a == b)
        {
            let start = hay[i].0;
            let end = hay
                .get(i + needle.len())
                .map(|(pos, _)| *pos)
                .unwrap_or(text.len());
            out.push((start, end));
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn tail_chars(text: &str, n: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= n {
        return (text.to_string(), false);
    }
    (text.chars().skip(count - n).collect(), true)
}

fn head_chars(text: &str, n: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= n {
        return (text.to_string(), false);
    }
    (text.chars().take(n).collect(), true)
}

pub fn search_text(text: &str, query: &str, max: usize) -> (Vec<TextHit>, usize) {
    let ranges = find_all(text, query);
    let total = ranges.len();
    let hits = ranges
        .into_iter()
        .take(max)
        .enumerate()
        .map(|(occurrence, (start, end))| {
            let (before, cut_before) = tail_chars(&text[..start], SNIPPET_RADIUS);
            let (after, cut_after) = head_chars(&text[end..], SNIPPET_RADIUS);
            let mut before = one_line(&before);
            let mut after = one_line(&after);
            if text[..start].ends_with(char::is_whitespace) && !before.is_empty() {
                before.push(' ');
            }
            if text[end..].starts_with(char::is_whitespace) && !after.is_empty() {
                after.insert(0, ' ');
            }
            if cut_before {
                before.insert(0, '…');
            }
            if cut_after {
                after.push('…');
            }
            TextHit {
                occurrence,
                before,
                matched: text[start..end].to_string(),
                after,
            }
        })
        .collect();
    (hits, total)
}

/// Hits from every source, capped per source and overall, in source order.
pub fn search_sources(sources: &[HistorySource], query: &str) -> Vec<HistoryHit> {
    let mut out = Vec::new();
    for source in sources {
        if out.len() >= MAX_HITS {
            break;
        }
        let room = MAX_HITS_PER_SOURCE.min(MAX_HITS - out.len());
        let (hits, total) = search_text(&source.text, query, room);
        out.extend(hits.into_iter().map(|hit| HistoryHit {
            source: source.source.clone(),
            tab_id: source.tab_id.clone(),
            label: source.label.clone(),
            cwd: source.cwd.clone(),
            updated_at: source.updated_at.clone(),
            occurrence: hit.occurrence,
            total_in_source: total,
            before: hit.before,
            matched: hit.matched,
            after: hit.after,
        }));
    }
    out
}

fn folder_name(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("no folder")
        .to_string()
}

/// Open tabs first (their saved text, or their transcript file), then closed
/// tabs, then transcripts whose tab is gone. Terminal tabs have no chat text.
pub fn collect_sources(state: &StateStore, files: Vec<TranscriptFile>) -> Vec<HistorySource> {
    let mut files: Vec<Option<TranscriptFile>> = files.into_iter().map(Some).collect();
    let mut take_file = |id: &str| -> Option<TranscriptFile> {
        files
            .iter_mut()
            .find(|file| file.as_ref().is_some_and(|f| f.tab_id == id))
            .and_then(Option::take)
    };
    let mut out = Vec::new();
    for tab in &state.data.tabs {
        let file = take_file(&tab.id);
        if tab.kind == "terminal" {
            continue;
        }
        let saved = tab
            .transcript
            .clone()
            .filter(|text| !text.trim().is_empty());
        let (text, updated_at) = match (saved, file) {
            (Some(text), file) => (text, file.map(|f| f.updated_at)),
            (None, Some(file)) => (file.text, Some(file.updated_at)),
            (None, None) => continue,
        };
        out.push(HistorySource {
            source: "open".into(),
            tab_id: tab.id.clone(),
            label: tab.label.clone(),
            cwd: tab.cwd.clone(),
            updated_at,
            text,
        });
    }
    for tab in &state.data.closed_tabs {
        let Some(file) = take_file(&tab.id) else {
            continue;
        };
        out.push(HistorySource {
            source: "closed".into(),
            tab_id: tab.id.clone(),
            label: tab.label.clone(),
            cwd: tab.cwd.clone(),
            updated_at: Some(file.updated_at),
            text: file.text,
        });
    }
    for file in files.into_iter().flatten() {
        out.push(HistorySource {
            source: "archived".into(),
            label: format!("Saved chat · {}", folder_name(&file.cwd)),
            tab_id: file.tab_id,
            cwd: file.cwd,
            updated_at: Some(file.updated_at),
            text: file.text,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(kind: &str, id: &str, text: &str) -> HistorySource {
        HistorySource {
            source: kind.into(),
            tab_id: id.into(),
            label: format!("Tab {id}"),
            cwd: "/w".into(),
            updated_at: None,
            text: text.into(),
        }
    }

    #[test]
    fn matches_ignore_case_and_do_not_overlap() {
        assert_eq!(
            find_all("Foo foo FOO", "foo"),
            vec![(0, 3), (4, 7), (8, 11)]
        );
        assert_eq!(find_all("aaaa", "aa"), vec![(0, 2), (2, 4)]);
        assert_eq!(find_all("héllo HÉLLO", "héllo").len(), 2);
        assert!(find_all("abc", "").is_empty());
        assert!(find_all("abc", "   ").is_empty());
    }

    #[test]
    fn snippets_are_one_line_with_ellipses() {
        let text = format!(
            "{}\nthe needle is here\n{}",
            "x".repeat(100),
            "y".repeat(100)
        );
        let (hits, total) = search_text(&text, "NEEDLE", 5);
        assert_eq!(total, 1);
        let hit = &hits[0];
        assert_eq!(hit.matched, "needle");
        assert!(hit.before.starts_with('…'));
        assert!(hit.before.ends_with("the "));
        assert!(hit.after.starts_with(" is here "));
        assert!(hit.after.ends_with('…'));
        assert!(!hit.before.contains('\n'));
    }

    fn file(id: &str, text: &str) -> TranscriptFile {
        TranscriptFile {
            schema_version: 1,
            tab_id: id.into(),
            text: text.into(),
            cwd: "/work/Koneksi".into(),
            updated_at: "2026-10-06T00:00:00Z".into(),
            read_only: true,
        }
    }

    #[test]
    fn sources_cover_open_closed_and_archived_chats() {
        let mut state = StateStore {
            path: std::env::temp_dir().join("unused-state.json"),
            data: crate::store::AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
        };
        let tab = |id: &str, kind: &str, transcript: Option<&str>| {
            serde_json::from_value::<crate::store::TabRecord>(serde_json::json!({
                "id": id, "label": format!("L {id}"), "roleId": "r",
                "roleSnapshot": {"name": "R", "templateVersion": 1, "mode": "agent", "injection": "send_on_start"},
                "cwd": "/w", "answers": {}, "mergedPrompt": "", "mergedPromptHash": "",
                "phase": "draft", "order": 1, "createdAt": "now", "kind": kind,
                "transcript": transcript
            }))
            .unwrap()
        };
        state
            .data
            .tabs
            .push(tab("t_open", "role", Some("record text")));
        state.data.tabs.push(tab("t_file", "role", None));
        state.data.tabs.push(tab("t_term", "terminal", None));
        state.data.closed_tabs.push(
            serde_json::from_value(serde_json::json!({
                "id": "t_closed", "label": "Closed one", "roleId": "r",
                "roleSnapshot": {"name": "R", "templateVersion": 1, "mode": "agent", "injection": "send_on_start"},
                "cwd": "/w", "answers": {}, "mergedPrompt": "", "mergedPromptHash": "",
                "startupPromptSent": true, "closedAt": "now"
            }))
            .unwrap(),
        );
        let sources = collect_sources(
            &state,
            vec![
                file("t_open", "older file text"),
                file("t_file", "file text"),
                file("t_term", "terminal noise"),
                file("t_closed", "closed text"),
                file("t_gone", "gone text"),
            ],
        );
        let summary: Vec<(&str, &str, &str)> = sources
            .iter()
            .map(|s| (s.source.as_str(), s.tab_id.as_str(), s.text.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("open", "t_open", "record text"),
                ("open", "t_file", "file text"),
                ("closed", "t_closed", "closed text"),
                ("archived", "t_gone", "gone text"),
            ]
        );
        assert_eq!(sources[3].label, "Saved chat · Koneksi");
    }

    #[test]
    fn hits_are_capped_per_source_but_keep_the_total_and_occurrence() {
        let many = "hit ".repeat(50);
        let hits = search_sources(
            &[
                source("open", "t1", &many),
                source("archived", "t9", "one hit"),
            ],
            "hit",
        );
        let first: Vec<&HistoryHit> = hits.iter().filter(|h| h.tab_id == "t1").collect();
        assert_eq!(first.len(), MAX_HITS_PER_SOURCE);
        assert_eq!(first[0].total_in_source, 50);
        assert_eq!(first[3].occurrence, 3);
        let last = hits.last().unwrap();
        assert_eq!(
            (last.source.as_str(), last.tab_id.as_str()),
            ("archived", "t9")
        );
    }
}
