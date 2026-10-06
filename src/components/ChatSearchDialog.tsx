import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryHit } from "../bridge";
import { searchSegments, type SegmentLike } from "../search/textSearch";
import { TranscriptView } from "./TranscriptView";

export type ChatSearchHit = {
  key: string;
  /** "live" (an open chat's current messages), "open", "closed", "archived". */
  source: string;
  tabId: string;
  label: string;
  cwd?: string;
  updatedAt?: string | null;
  /** Live hits only: the message to jump to. */
  segmentId?: string;
  occurrence: number;
  before: string;
  match: string;
  after: string;
};

export type LiveChatSource = { tabId: string; label: string; segments: SegmentLike[] };

type Props = {
  initialQuery: string;
  liveSources: LiveChatSource[];
  search: (query: string) => Promise<HistoryHit[]>;
  loadTranscript: (tabId: string) => Promise<string>;
  /** Open (or reopen) the tab and land on the hit. Not called for archived hits. */
  onJump: (hit: ChatSearchHit, query: string) => void;
  onClose: () => void;
};

const LIVE_HITS_PER_TAB = 20;
const DEBOUNCE_MS = 200;

const SOURCE_LABEL: Record<string, string> = {
  live: "Open chat",
  open: "Saved in tab",
  closed: "Closed tab",
  archived: "Saved transcript",
};

function liveHits(sources: LiveChatSource[], query: string): ChatSearchHit[] {
  if (!query.trim()) return [];
  return sources.flatMap((source) =>
    searchSegments(source.segments, query)
      .slice(0, LIVE_HITS_PER_TAB)
      .map((hit) => ({
        key: `live:${source.tabId}:${hit.segmentId}:${hit.occurrence}`,
        source: "live",
        tabId: source.tabId,
        label: source.label,
        segmentId: hit.segmentId,
        occurrence: hit.occurrence,
        before: hit.before,
        match: hit.match,
        after: hit.after,
      })),
  );
}

function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

/** F5: search every chat, closed tab, and saved transcript; jump to the hit. */
export function ChatSearchDialog({
  initialQuery,
  liveSources,
  search,
  loadTranscript,
  onJump,
  onClose,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [saved, setSaved] = useState<{ query: string; hits: HistoryHit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<{ hit: ChatSearchHit; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const q = query.trim();
    setError(null);
    if (!q) {
      setSaved(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(query)
        .then((hits) => {
          if (!cancelled) setSaved({ query, hits });
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, search]);

  const results = useMemo(() => {
    const live = liveHits(liveSources, query);
    const liveTabs = new Set(liveSources.map((source) => source.tabId));
    const fromDisk =
      saved && saved.query === query
        ? saved.hits
            // An open chat's current messages beat its last saved copy.
            .filter((hit) => !(hit.source === "open" && liveTabs.has(hit.tabId)))
            .map<ChatSearchHit>((hit) => ({
              key: `${hit.source}:${hit.tabId}:${hit.occurrence}`,
              source: hit.source,
              tabId: hit.tabId,
              label: hit.label,
              cwd: hit.cwd,
              updatedAt: hit.updatedAt,
              occurrence: hit.occurrence,
              before: hit.before,
              match: hit.matched,
              after: hit.after,
            }))
        : [];
    return [...live, ...fromDisk];
  }, [liveSources, query, saved]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const activate = async (hit: ChatSearchHit | undefined) => {
    if (!hit) return;
    if (hit.source !== "archived") {
      onJump(hit, query);
      return;
    }
    try {
      setPreview({ hit, text: await loadTranscript(hit.tabId) });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pending = query.trim() !== "" && (!saved || saved.query !== query) && !error;

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel chat-search-dialog"
        role="dialog"
        aria-label="Search chats"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="search"
          className="text-input"
          aria-label="Search chats"
          placeholder="Search open chats, closed tabs, and saved transcripts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((at) => Math.min(at + 1, Math.max(results.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((at) => Math.max(at - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              void activate(results[index]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (preview) setPreview(null);
              else onClose();
            }
          }}
        />
        <p className="hint chat-search-status" aria-live="polite">
          {error
            ? error
            : !query.trim()
              ? "Type to search. Enter opens the chat at the match."
              : pending && results.length === 0
                ? "Searching…"
                : results.length === 0
                  ? "No matches."
                  : `${results.length} match${results.length === 1 ? "" : "es"}${pending ? " (still searching saved chats…)" : ""}`}
        </p>
        <div className={preview ? "chat-search-body chat-search-body-preview" : "chat-search-body"}>
          {results.length > 0 && (
            <ul className="chat-search-results" role="listbox" aria-label="Search results">
              {results.map((hit, i) => (
                <li
                  key={hit.key}
                  role="option"
                  aria-selected={i === index}
                  className={i === index ? "chat-search-hit chat-search-hit-active" : "chat-search-hit"}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => void activate(hit)}
                >
                  <div className="chat-search-hit-head">
                    <strong>{hit.label}</strong>
                    <span className={`chat-search-source chat-search-source-${hit.source}`}>
                      {SOURCE_LABEL[hit.source] ?? hit.source}
                    </span>
                    {hit.updatedAt && <span className="hint">{dateLabel(hit.updatedAt)}</span>}
                  </div>
                  <div className="chat-search-snippet">
                    {hit.before}
                    <mark className="search-hit">{hit.match}</mark>
                    {hit.after}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {preview && (
            <div className="chat-search-preview">
              <div className="chat-search-preview-bar">
                <strong>{preview.hit.label}</strong>
                <span className="hint">{preview.hit.cwd}</span>
                <button type="button" className="secondary-button" onClick={() => setPreview(null)}>
                  Close preview
                </button>
              </div>
              <TranscriptView
                text={preview.text}
                query={query}
                occurrence={preview.hit.occurrence}
                label="Transcript preview"
                className="mono-snippet transcript-preview chat-search-preview-text"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
