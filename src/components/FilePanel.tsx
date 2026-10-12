import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  filesList,
  filesRead,
  filesReveal,
  filesWrite,
  type FileContent,
  type FileEntry,
} from "../bridge";
import { highlightCode } from "../files/highlight";
import { formatSize, isSaveChord, joinRoot } from "../files/paths";
import type { Platform } from "../keymap";
import { useConfirm } from "./confirm";
import { PanelHeader } from "./PanelHeader";

/** What the parent asks before it closes or swaps the panel away. */
export type FileDiscardGuard = {
  /** True while the open file has edits that are not saved. */
  dirty: () => boolean;
  /** Ask in the panel; resolves true once the user agrees to drop the edits. */
  confirm: () => Promise<boolean>;
};

type Props = {
  tabId: string;
  /** The tab's working folder. Empty when the tab has none yet. */
  cwd: string;
  platform: Platform;
  /** Open this file (relative to `cwd`) and focus it; a new nonce repeats it. */
  focusFile?: { path: string; nonce: number } | null;
  onInsertReference: (path: string) => void;
  onClose: () => void;
  /** Filled while mounted so the parent can guard closing, tab switch and Settings. */
  discardGuardRef?: MutableRefObject<FileDiscardGuard | null>;
};

type DirState = {
  entries: FileEntry[];
  truncated: boolean;
  error: string | null;
  loading: boolean;
};

const CONFLICT = "CONFLICT:";
const DISCARD_MESSAGE = "Discard your unsaved edits to this file?";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function FilePanel({
  tabId,
  cwd,
  platform,
  focusFile,
  onInsertReference,
  onClose,
  discardGuardRef,
}: Props) {
  const confirm = useConfirm();
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [root, setRoot] = useState("");
  const [selected, setSelected] = useState<{ path: string; isDir: boolean } | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const dirty = editing && file?.text != null && draft !== file.text;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const loadDir = useCallback(
    async (path: string) => {
      setDirs((prev) => ({
        ...prev,
        [path]: { entries: prev[path]?.entries ?? [], truncated: false, error: null, loading: true },
      }));
      try {
        const listing = await filesList(tabId, path);
        setRoot(listing.root);
        setDirs((prev) => ({
          ...prev,
          [path]: {
            entries: listing.entries,
            truncated: listing.truncated,
            error: null,
            loading: false,
          },
        }));
      } catch (err: unknown) {
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: [], truncated: false, error: errorText(err), loading: false },
        }));
      }
    },
    [tabId],
  );

  // Ask before unsaved edits are dropped. Only the newest question can go
  // ahead: an answer to an older one that a newer one superseded counts as
  // "keep editing", and an open question resolves false if the panel unmounts.
  const askSeqRef = useRef(0);
  const cancelAsksRef = useRef(new Set<() => void>());
  useEffect(() => {
    const cancels = cancelAsksRef.current;
    return () => {
      for (const cancel of cancels) cancel();
      cancels.clear();
    };
  }, []);
  const askDiscard = useCallback(
    async (message: string, cancelLabel = "Keep editing"): Promise<boolean> => {
      const seq = ++askSeqRef.current;
      const ok = await new Promise<boolean>((resolve) => {
        const cancels = cancelAsksRef.current;
        const cancel = () => resolve(false);
        cancels.add(cancel);
        confirm({
          title: "Discard unsaved edits",
          message,
          confirmLabel: "Discard edits",
          cancelLabel,
          danger: true,
        })
          .then(resolve, () => resolve(false))
          .finally(() => cancels.delete(cancel));
      });
      return ok && seq === askSeqRef.current;
    },
    [confirm],
  );

  // Run `run` now, or after the user agrees to drop unsaved edits.
  const guardDiscard = async (
    run: () => void | Promise<void>,
    message = DISCARD_MESSAGE,
  ): Promise<void> => {
    if (dirtyRef.current && !(await askDiscard(message))) return;
    await run();
  };

  useEffect(() => {
    if (!discardGuardRef) return;
    discardGuardRef.current = {
      dirty: () => dirtyRef.current,
      confirm: async () => !dirtyRef.current || (await askDiscard(DISCARD_MESSAGE)),
    };
    return () => {
      discardGuardRef.current = null;
    };
  }, [discardGuardRef, askDiscard]);

  // A new working folder resets the panel. With unsaved edits it waits for
  // the user, who can keep the text to copy it out first.
  const shownCwdRef = useRef<string | null>(null);
  useEffect(() => {
    const reset = () => {
      shownCwdRef.current = cwd;
      setDirs({});
      setExpanded(new Set([""]));
      setSelected(null);
      setFile(null);
      setEditing(false);
      setConflict(false);
      setNotice(null);
      if (cwd) void loadDir("");
    };
    if (shownCwdRef.current !== null && shownCwdRef.current !== cwd && dirtyRef.current) {
      void askDiscard(
        "The working folder changed. Discard your unsaved edits to this file?",
        "Keep my edits",
      ).then((ok) => {
        if (ok) reset();
      });
      return;
    }
    reset();
  }, [cwd, loadDir, tabId, askDiscard]);

  const openFile = (path: string) => guardDiscard(() => doOpenFile(path));

  const doOpenFile = async (path: string) => {
    setSelected({ path, isDir: false });
    setEditing(false);
    setConflict(false);
    setFileError(null);
    setNotice(null);
    try {
      const content = await filesRead(tabId, path);
      setFile(content);
      setDraft(content.text ?? "");
    } catch (err: unknown) {
      setFile(null);
      setFileError(errorText(err));
    }
  };

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  // F4 "Open in file panel": expand the folders on the way, open the file.
  const revealPath = focusFile?.path;
  const revealNonce = focusFile?.nonce;
  useEffect(() => {
    if (!revealPath || !cwd) return;
    let cancelled = false;
    const parts = revealPath.split("/").filter(Boolean);
    const folders = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    void (async () => {
      for (const folder of folders) {
        if (cancelled) return;
        await loadDir(folder);
      }
      if (cancelled) return;
      setExpanded((prev) => new Set([...prev, "", ...folders]));
      await openFileRef.current(revealPath);
      if (!cancelled) setFocusPath(revealPath);
    })();
    return () => {
      cancelled = true;
    };
  }, [revealPath, revealNonce, cwd, loadDir]);

  useEffect(() => {
    if (!focusPath) return;
    const items = panelRef.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [];
    const target = Array.from(items).find((item) => item.dataset.path === focusPath);
    if (target) {
      target.focus();
      target.scrollIntoView?.({ block: "nearest" });
      setFocusPath(null);
    } else if (!panelRef.current?.contains(document.activeElement)) {
      panelRef.current?.focus();
    }
  });

  const toggleDir = (path: string) => {
    setSelected({ path, isDir: true });
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!dirs[path]) void loadDir(path);
      }
      return next;
    });
  };

  const save = async (force = false) => {
    if (!file || !editing || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await filesWrite(tabId, file.path, draft, file.mtimeMs, force);
      setFile({ ...file, text: draft, mtimeMs: result.mtimeMs, size: result.size });
      setConflict(false);
      setNotice("Saved.");
    } catch (err: unknown) {
      const message = errorText(err);
      if (message.startsWith(CONFLICT)) setConflict(true);
      else setNotice(message);
    } finally {
      setSaving(false);
    }
  };

  const reload = () => {
    if (!file) return;
    void guardDiscard(() => doReload(), "Reload from disk and drop your edits?");
  };

  const doReload = async () => {
    if (!file) return;
    try {
      const content = await filesRead(tabId, file.path);
      setFile(content);
      setDraft(content.text ?? "");
      setConflict(false);
      setNotice("Reloaded from disk.");
    } catch (err: unknown) {
      setNotice(errorText(err));
    }
  };

  const copyPath = async () => {
    if (!selected) return;
    const abs = file && file.path === selected.path ? file.absPath : joinRoot(root, selected.path);
    try {
      await navigator.clipboard.writeText(abs);
      setNotice("Path copied.");
    } catch (err: unknown) {
      setNotice(errorText(err));
    }
  };

  const reveal = async () => {
    if (!selected) return;
    try {
      await filesReveal(tabId, selected.path);
    } catch (err: unknown) {
      setNotice(errorText(err));
    }
  };

  const highlighted = useMemo(() => {
    if (!file || file.kind !== "text" || file.text == null) return null;
    return highlightCode(file.text, file.path);
  }, [file]);

  const renderDir = (path: string, depth: number) => {
    const state = dirs[path];
    if (!state) return null;
    return (
      <ul className="file-tree-list" role={depth === 0 ? "tree" : "group"}>
        {state.loading && state.entries.length === 0 && <li className="hint">Loading…</li>}
        {state.error && <li className="error">{state.error}</li>}
        {state.entries.map((entry) => {
          const open = expanded.has(entry.path);
          const isSelected = selected?.path === entry.path;
          return (
            <li key={entry.path} role="treeitem" aria-expanded={entry.isDir ? open : undefined}>
              <button
                type="button"
                className={isSelected ? "file-tree-item file-tree-item-selected" : "file-tree-item"}
                style={{ paddingLeft: 8 + depth * 12 }}
                title={entry.path}
                data-path={entry.path}
                onClick={() => (entry.isDir ? toggleDir(entry.path) : void openFile(entry.path))}
              >
                <span className="file-tree-icon" aria-hidden>
                  {entry.isDir ? (open ? "▾" : "▸") : "·"}
                </span>
                <span className="file-tree-name">{entry.name}</span>
              </button>
              {entry.isDir && open && renderDir(entry.path, depth + 1)}
            </li>
          );
        })}
        {!state.loading && !state.error && state.entries.length === 0 && (
          <li className="hint" style={{ paddingLeft: 8 + depth * 12 }}>
            Empty
          </li>
        )}
        {state.truncated && (
          <li className="hint" style={{ paddingLeft: 8 + depth * 12 }}>
            Showing the first {state.entries.length} entries.
          </li>
        )}
      </ul>
    );
  };

  const actions = selected && (
    <div className="file-panel-actions">
      <button type="button" className="secondary-button" onClick={() => void reveal()}>
        {platform === "mac" ? "Reveal in Finder" : "Show in folder"}
      </button>
      <button type="button" className="secondary-button" onClick={() => void copyPath()}>
        Copy path
      </button>
      <button
        type="button"
        className="secondary-button"
        onClick={() => onInsertReference(selected.path)}
        title="Insert @file into the scratch pad"
      >
        Insert @file
      </button>
    </div>
  );

  const preview = file && (
    <div className="file-preview">
      <div className="file-preview-bar">
        <span className="file-preview-name" title={file.absPath}>
          {file.path}
          {dirty ? " •" : ""}
        </span>
        <span className="hint">{formatSize(file.size)}</span>
        {file.kind === "text" && (
          <button
            type="button"
            className="secondary-button"
            aria-pressed={editing}
            onClick={async () => {
              if (editing) {
                void guardDiscard(() => {
                  setDraft(file.text ?? "");
                  setEditing(false);
                  setConflict(false);
                });
              } else {
                setEditing(true);
                window.setTimeout(() => editorRef.current?.focus(), 0);
              }
            }}
          >
            {editing ? "View" : "Edit"}
          </button>
        )}
        {editing && (
          <button
            type="button"
            className="primary-button"
            disabled={saving || !dirty}
            onClick={() => void save(false)}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {conflict && (
        <div className="file-conflict" role="alert">
          <span>This file changed on disk after you opened it.</span>
          <button type="button" className="secondary-button" onClick={() => void save(true)}>
            Overwrite
          </button>
          <button type="button" className="secondary-button" onClick={() => void reload()}>
            Reload
          </button>
        </div>
      )}
      {file.kind === "image" && file.dataBase64 && file.mime && (
        <div className="file-preview-image">
          <img src={`data:${file.mime};base64,${file.dataBase64}`} alt={file.path} />
        </div>
      )}
      {file.kind === "binary" && <p className="hint">Binary file. No preview.</p>}
      {file.kind === "tooLarge" && (
        <p className="hint">This file is too large to preview ({formatSize(file.size)}).</p>
      )}
      {file.kind === "text" &&
        (editing ? (
          <textarea
            ref={editorRef}
            className="file-editor"
            aria-label={`Edit ${file.path}`}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (isSaveChord(event, platform === "mac")) {
                event.preventDefault();
                event.stopPropagation();
                void save(false);
              }
            }}
          />
        ) : (
          <pre className="file-code hljs">
            <code
              className={highlighted?.language ? `language-${highlighted.language}` : undefined}
              dangerouslySetInnerHTML={{ __html: highlighted?.html ?? "" }}
            />
          </pre>
        ))}
    </div>
  );

  return (
    <aside className="file-panel" aria-label="Files" ref={panelRef} tabIndex={-1}>
      <PanelHeader
        title="Files"
        subtitle={(root || cwd).split(/[\\/]/).filter(Boolean).pop() ?? ""}
        subtitleTitle={root || cwd}
        closeLabel="Close file panel"
        onClose={() => void guardDiscard(onClose)}
        actions={
          <button
            type="button"
            className="secondary-button"
            disabled={!cwd}
            onClick={() =>
              void guardDiscard(() => {
                setDirs({});
                setExpanded(new Set([""]));
                void loadDir("");
              })
            }
          >
            Refresh
          </button>
        }
      />
      {!cwd ? (
        <p className="hint file-panel-empty">Choose a working folder first.</p>
      ) : (
        <PanelGroup direction="vertical" className="file-panel-body">
          <Panel id="file-tree" order={1} minSize={15} defaultSize={file || fileError ? 40 : 100}>
            <div className="file-tree">{renderDir("", 0)}</div>
          </Panel>
          {(file || fileError) && (
            <>
              <PanelResizeHandle className="split-handle" />
              <Panel id="file-preview" order={2} minSize={20} defaultSize={60}>
                <div className="file-preview-wrap">
                  {fileError && <p className="error">{fileError}</p>}
                  {preview}
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
      )}
      {actions}
      {notice && <p className="hint file-panel-notice">{notice}</p>}
    </aside>
  );
}
