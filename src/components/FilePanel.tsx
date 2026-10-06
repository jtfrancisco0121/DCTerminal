import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type Props = {
  tabId: string;
  /** The tab's working folder. Empty when the tab has none yet. */
  cwd: string;
  platform: Platform;
  onInsertReference: (path: string) => void;
  onClose: () => void;
};

type DirState = {
  entries: FileEntry[];
  truncated: boolean;
  error: string | null;
  loading: boolean;
};

const CONFLICT = "CONFLICT:";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function FilePanel({ tabId, cwd, platform, onInsertReference, onClose }: Props) {
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

  useEffect(() => {
    setDirs({});
    setExpanded(new Set([""]));
    setSelected(null);
    setFile(null);
    setEditing(false);
    setConflict(false);
    setNotice(null);
    if (cwd) void loadDir("");
  }, [cwd, loadDir, tabId]);

  const confirmDiscard = () =>
    !dirtyRef.current || window.confirm("Discard your unsaved edits to this file?");

  const openFile = async (path: string) => {
    if (!confirmDiscard()) return;
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

  const reload = async () => {
    if (!file) return;
    if (dirty && !window.confirm("Reload from disk and drop your edits?")) return;
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
            onClick={() => {
              if (editing) {
                if (!confirmDiscard()) return;
                setDraft(file.text ?? "");
                setEditing(false);
                setConflict(false);
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
    <aside className="file-panel" aria-label="Files">
      <div className="file-panel-bar">
        <strong>Files</strong>
        <span className="hint file-panel-root" title={root || cwd}>
          {(root || cwd).split(/[\\/]/).filter(Boolean).pop() ?? ""}
        </span>
        <button
          type="button"
          className="secondary-button"
          disabled={!cwd}
          onClick={() => {
            if (!confirmDiscard()) return;
            setDirs({});
            setExpanded(new Set([""]));
            void loadDir("");
          }}
        >
          Refresh
        </button>
        <button type="button" className="secondary-button" aria-label="Close file panel" onClick={onClose}>
          ×
        </button>
      </div>
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
