import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PromptLibrary } from "../bridge";
import { defaultPromptName, filterPrompts } from "../prompts/library";
import {
  REPLY_TEMPLATES,
  REPLY_TEMPLATE_ROLE_LABELS,
  replyTemplateRoleOrder,
  whenParts,
  type ReplyTemplateRole,
} from "../prompts/replyTemplates";
import { Dialog } from "./Dialog";
import { InlineNotice, errorText } from "./InlineNotice";
import { useConfirm } from "./confirm";

export type PromptLibraryView = "saved" | "recent" | "templates";

type Form = { id: string | null; name: string; body: string };

type Item = {
  key: string;
  title: string;
  body: string;
  promptId: string | null;
  meta: string;
  /** Set on built-in reply templates (read-only). */
  template?: { roleId: ReplyTemplateRole; when: string };
};

type Props = {
  /** null while the library is loading. */
  library: PromptLibrary | null;
  loadError?: string | null;
  /** false when there is no tab with a scratch pad to insert into. */
  canInsert: boolean;
  /** Open straight into "Save as prompt" with this text (the scratch pad). */
  saveDraft?: string | null;
  /** Starting list; Saved unless a caller asks for another (e.g. "Reply templates…"). */
  initialView?: PromptLibraryView;
  /** The active tab's role: its reply templates are listed first. */
  roleId?: string | null;
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

const message = errorText;

/** A "use when" line, with its backtick spans shown as inline code. */
function WhenLine({ when }: { when: string }) {
  return (
    <span className="hint prompt-library-when">
      {whenParts(when).map((part, i) =>
        part.code ? <code key={i}>{part.text}</code> : <span key={i}>{part.text}</span>,
      )}
    </span>
  );
}

/** F6: saved prompts, recent sends and built-in reply templates; insert into the scratch pad. */
export function PromptLibraryDialog({
  library,
  loadError = null,
  canInsert,
  saveDraft = null,
  initialView = "saved",
  roleId = null,
  onInsert,
  onSave,
  onDelete,
  onClearRecent,
  onClose,
}: Props) {
  const confirm = useConfirm();
  const [view, setView] = useState<PromptLibraryView>(initialView);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [form, setForm] = useState<Form | null>(() =>
    saveDraft != null ? { id: null, name: defaultPromptName(saveDraft), body: saveDraft } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const roleOrder = useMemo(() => replyTemplateRoleOrder(roleId), [roleId]);

  const items: Item[] = useMemo(() => {
    if (view === "templates") {
      const matches = filterPrompts(
        REPLY_TEMPLATES.map((t) => ({ ...t, name: t.title })),
        query,
      );
      return roleOrder.flatMap((role) =>
        matches
          .filter((t) => t.roleId === role)
          .map((t) => ({
            key: t.id,
            title: t.title,
            body: t.body,
            promptId: null,
            meta: "",
            template: { roleId: t.roleId, when: t.when },
          })),
      );
    }
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
  }, [library, query, view, roleOrder]);

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
  const listLabel =
    view === "saved" ? "Saved prompts" : view === "recent" ? "Recent sends" : "Reply templates";
  const placeholder =
    view === "saved"
      ? "Filter saved prompts"
      : view === "recent"
        ? "Filter recent sends"
        : "Filter reply templates";

  const renderItem = (item: Item, i: number) => (
    <li
      key={item.key}
      role="option"
      aria-selected={item === current}
      className={item === current ? "prompt-library-item active" : "prompt-library-item"}
      onClick={() => setIndex(i)}
      onDoubleClick={() => insert(item)}
    >
      <span className="prompt-library-name">{item.title}</span>
      {item.template ? (
        <WhenLine when={item.template.when} />
      ) : (
        item.meta && <span className="hint">{item.meta}</span>
      )}
    </li>
  );

  /** Templates render under role headings; `items` is already in that order. */
  const renderTemplateGroups = () =>
    roleOrder.map((role) => {
      const inGroup = items
        .map((item, i) => ({ item, i }))
        .filter(({ item }) => item.template?.roleId === role);
      if (inGroup.length === 0) return null;
      const label = REPLY_TEMPLATE_ROLE_LABELS[role];
      return (
        <li key={role} role="group" aria-label={label} className="prompt-library-group">
          <span className="prompt-library-group-name" aria-hidden="true">
            {label}
          </span>
          <ul role="none">{inGroup.map(({ item, i }) => renderItem(item, i))}</ul>
        </li>
      );
    });

  return (
    <Dialog title="Prompt library" className="prompt-library" onClose={onClose}>
        <div className="prompt-library-head">
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
            <button
              type="button"
              role="tab"
              aria-selected={view === "templates"}
              className={view === "templates" ? "prompt-library-tab active" : "prompt-library-tab"}
              onClick={() => setView("templates")}
            >
              Reply templates ({REPLY_TEMPLATES.length})
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
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
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
              placeholder={placeholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onFilterKey}
            />
            {loadError && <InlineNotice tone="error">{loadError}</InlineNotice>}
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
            <div className="prompt-library-body-grid">
              {view !== "templates" && !library && !loadError ? (
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
                  {view === "templates" ? renderTemplateGroups() : items.map(renderItem)}
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
                            if (!id) return;
                            void confirm({
                              title: "Delete prompt",
                              message: `Delete the prompt "${current.title}"?`,
                              confirmLabel: "Delete",
                              danger: true,
                            }).then((ok) => {
                              if (ok) void run(() => onDelete(id));
                            });
                          }}
                        >
                          Delete
                        </button>
                      </>
                    ) : current.template ? (
                      <button
                        type="button"
                        className="secondary-button"
                        title="Templates are read-only; save your own editable copy"
                        onClick={() => {
                          setError(null);
                          setForm({ id: null, name: current.title, body: current.body });
                        }}
                      >
                        Save a copy…
                      </button>
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
                  void confirm({
                    title: "Clear recent sends",
                    message: "Clear the list of recent sends?",
                    confirmLabel: "Clear list",
                    danger: true,
                  }).then((ok) => {
                    if (ok) void run(onClearRecent);
                  });
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
    </Dialog>
  );
}
