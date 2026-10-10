import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PromptLibrary } from "../bridge";
import { defaultPromptName, filterPrompts } from "../prompts/library";

type View = "saved" | "recent";

type Form = { id: string | null; name: string; body: string };

type Item = { key: string; title: string; body: string; promptId: string | null; meta: string };

type Props = {
  /** null while the library is loading. */
  library: PromptLibrary | null;
  loadError?: string | null;
  /** false when there is no tab with a scratch pad to insert into. */
  canInsert: boolean;
  /** Open straight into "Save as prompt" with this text (the scratch pad). */
  saveDraft?: string | null;
  onInsert: (text: string, promptId: string | null) => void;
  /** Rejects with a message the dialog shows (e.g. duplicate name). */
  onSave: (id: string | null, name: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClearRecent: () => Promise<void>;
  onClose: () => void;
};

function when(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** F6: saved named prompts and recent sends; insert into the scratch pad. */
export function PromptLibraryDialog({
  library,
  loadError = null,
  canInsert,
  saveDraft = null,
  onInsert,
  onSave,
  onDelete,
  onClearRecent,
  onClose,
}: Props) {
  const [view, setView] = useState<View>("saved");
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [form, setForm] = useState<Form | null>(() =>
    saveDraft != null ? { id: null, name: defaultPromptName(saveDraft), body: saveDraft } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const items: Item[] = useMemo(() => {
    if (!library) return [];
    if (view === "saved") {
      return filterPrompts(library.prompts, query).map((p) => ({
        key: p.id,
        title: p.name,
        body: p.body,
        promptId: p.id,
        meta: p.lastUsedAt ? `used ${when(p.lastUsedAt)}` : "",
      }));
    }
    return filterPrompts(library.recent, query).map((r, i) => ({
      key: `${i}:${r.sentAt}`,
      title: defaultPromptName(r.text) || "(blank)",
      body: r.text,
      promptId: null,
      meta: `${r.source === "terminal" ? "terminal" : "chat"} · ${when(r.sentAt)}`,
    }));
  }, [library, query, view]);

  const current = items[Math.min(index, items.length - 1)] ?? null;

  useEffect(() => {
    setIndex(0);
  }, [query, view]);

  const formOpen = form !== null;
  useEffect(() => {
    if (formOpen) nameRef.current?.focus();
    else filterRef.current?.focus();
  }, [formOpen, view]);

  const insert = (item: Item | null) => {
    if (!item || !canInsert) return;
    onInsert(item.body, item.promptId);
  };

  const submit = async () => {
    if (!form || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(form.id, form.name, form.body);
      setForm(null);
    } catch (err: unknown) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const run = async (job: () => Promise<void>) => {
    setError(null);
    try {
      await job();
    } catch (err: unknown) {
      setError(message(err));
    }
  };

  const onFilterKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((at) => Math.min(at + 1, Math.max(items.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((at) => Math.max(at - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      insert(current);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const onFormKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setForm(null);
      setError(null);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const savedCount = library?.prompts.length ?? 0;
  const recentCount = library?.recent.length ?? 0;
  const listLabel = view === "saved" ? "Saved prompts" : "Recent sends";

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel prompt-library"
        role="dialog"
        aria-label="Prompt library"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="prompt-library-head">
          <h3>Prompt library</h3>
          <div className="prompt-library-tabs" role="tablist" aria-label="Prompt lists">
            <button
              type="button"
              role="tab"
              aria-selected={view === "saved"}
              className={view === "saved" ? "prompt-library-tab active" : "prompt-library-tab"}
              onClick={() => setView("saved")}
            >
              Saved ({savedCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "recent"}
              className={view === "recent" ? "prompt-library-tab active" : "prompt-library-tab"}
              onClick={() => setView("recent")}
            >
              Recent sends ({recentCount})
            </button>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setError(null);
              setForm({ id: null, name: "", body: "" });
            }}
          >
            New prompt
          </button>
        </div>

        {form ? (
          <div className="prompt-library-form" onKeyDown={onFormKey} data-own-escape="">
            <label>
              <span>Name</span>
              <input
                ref={nameRef}
                className="text-input"
                aria-label="Prompt name"
                value={form.name}
                maxLength={120}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label>
              <span>Prompt</span>
              <textarea
                className="text-input prompt-library-body"
                aria-label="Prompt text"
                rows={8}
                spellCheck={false}
                value={form.body}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
              />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="prompt-library-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy || !form.name.trim() || !form.body.trim()}
                onClick={() => void submit()}
              >
                Save prompt
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setForm(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <input
              ref={filterRef}
              type="search"
              className="text-input"
              aria-label="Filter prompts"
              placeholder={view === "saved" ? "Filter saved prompts" : "Filter recent sends"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onFilterKey}
            />
            {loadError && <p className="error">{loadError}</p>}
            {error && <p className="error">{error}</p>}
            <div className="prompt-library-body-grid">
              {!library && !loadError ? (
                <p className="hint">Loading…</p>
              ) : items.length === 0 ? (
                <p className="hint prompt-library-empty">
                  {query.trim()
                    ? "Nothing matches."
                    : view === "saved"
                      ? "No saved prompts yet. Use New prompt, or Save as prompt on a recent send or the scratch pad."
                      : "Prompts you send from a chat or a terminal pad show up here."}
                </p>
              ) : (
                <ul className="prompt-library-list" role="listbox" aria-label={listLabel}>
                  {items.map((item, i) => (
                    <li
                      key={item.key}
                      role="option"
                      aria-selected={item === current}
                      className={
                        item === current ? "prompt-library-item active" : "prompt-library-item"
                      }
                      onClick={() => setIndex(i)}
                      onDoubleClick={() => insert(item)}
                    >
                      <span className="prompt-library-name">{item.title}</span>
                      {item.meta && <span className="hint">{item.meta}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {current && (
                <div className="prompt-library-preview">
                  <pre className="mono-snippet" aria-label="Prompt preview">
                    {current.body}
                  </pre>
                  <div className="prompt-library-actions">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!canInsert}
                      title={canInsert ? undefined : "Open a tab with a scratch pad first"}
                      onClick={() => insert(current)}
                    >
                      Insert into scratch pad
                    </button>
                    {current.promptId ? (
                      <>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            setError(null);
                            setForm({ id: current.promptId, name: current.title, body: current.body });
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            const id = current.promptId;
                            if (!id || !window.confirm(`Delete the prompt "${current.title}"?`)) return;
                            void run(() => onDelete(id));
                          }}
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setError(null);
                          setForm({ id: null, name: defaultPromptName(current.body), body: current.body });
                        }}
                      >
                        Save as prompt…
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            {view === "recent" && recentCount > 0 && (
              <button
                type="button"
                className="link-button prompt-library-clear"
                onClick={() => {
                  if (window.confirm("Clear the list of recent sends?")) void run(onClearRecent);
                }}
              >
                Clear recent sends
              </button>
            )}
          </>
        )}
        {library && (
          <p className="hint prompt-library-path">
            Stored in DCTerminal's app data: <code>{library.path}</code>
          </p>
        )}
      </div>
    </div>
  );
}
