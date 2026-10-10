import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  changesFileDiff,
  changesList,
  changesRevert,
  changesSnapshot,
  type ChangeScope,
  type ChangeSet,
  type ChangedFile,
  type FileDiff,
} from "../bridge";
import {
  acceptKey,
  parseUnifiedDiff,
  revertConfirmText,
  statusLetter,
  statusWord,
  toSplitRows,
  unaccepted,
  type DiffLine,
} from "../changes/diffModel";

type View = "unified" | "split";

type Props = {
  tabId: string;
  tabLabel: string;
  /** The tab's agent or terminal is still working: reverting is blocked. */
  busy: boolean;
  accepted: ReadonlySet<string>;
  onAccept: (key: string) => void;
  /** Path relative to the tab's folder. */
  onOpenInFilePanel: (path: string) => void;
  onClose: () => void;
};

const VIEW_KEY = "dcterminal.diffView";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Cell({ line, side }: { line: DiffLine | null; side: "old" | "new" }) {
  if (!line) {
    return (
      <>
        <td className="diff-no" />
        <td className="diff-text diff-empty" />
      </>
    );
  }
  const no = side === "old" ? line.oldNo : line.newNo;
  return (
    <>
      <td className="diff-no">{no ?? ""}</td>
      <td className={`diff-text diff-${line.kind}`}>{line.text}</td>
    </>
  );
}

/** F4: what changed since this turn (or tab) started, with Accept / Revert. */
export function ChangesPanel({
  tabId,
  tabLabel,
  busy,
  accepted,
  onAccept,
  onOpenInFilePanel,
  onClose,
}: Props) {
  const [scope, setScope] = useState<ChangeScope>("turn");
  const [view, setView] = useState<View>(readView);
  const [set, setSet] = useState<ChangeSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);

  const apply = useCallback((next: ChangeSet) => {
    setSet(next);
    setSelected((current) =>
      current && next.files.some((file) => file.path === current)
        ? current
        : (next.files[0]?.path ?? null),
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      apply(await changesList(tabId, scope));
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [apply, scope, tabId]);

  useEffect(() => {
    void load();
  }, [load]);

  const file = set?.files.find((item) => item.path === selected) ?? null;

  useEffect(() => {
    setDiff(null);
    setDiffError(null);
    if (!file || !set?.baseTree || !set.nowTree) return;
    let cancelled = false;
    changesFileDiff(tabId, set.baseTree, set.nowTree, file.path)
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setDiffError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [file, set?.baseTree, set?.nowTree, tabId]);

  const hunks = useMemo(() => (diff && !diff.binary ? parseUnifiedDiff(diff.text) : []), [diff]);
  const pending = set ? unaccepted(set.files, accepted) : [];

  const chooseView = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Storage can be unavailable; the choice still applies now.
    }
  };

  const revert = async (files: ChangedFile[], kept = 0) => {
    if (!set?.baseTree || files.length === 0 || busy || reverting) return;
    if (!window.confirm(revertConfirmText(files, kept))) return;
    setReverting(true);
    setNotice(null);
    try {
      const outcome = await changesRevert(
        tabId,
        set.baseTree,
        files.map((item) => ({ path: item.path, newBlob: item.newBlob })),
        true,
      );
      const parts: string[] = [];
      if (outcome.reverted.length > 0) {
        parts.push(
          `Reverted ${outcome.reverted.length} file${outcome.reverted.length === 1 ? "" : "s"}.`,
        );
      }
      for (const skip of outcome.skipped) parts.push(`Skipped ${skip.path}: ${skip.reason}.`);
      setNotice(parts.join(" ") || "Nothing to revert.");
      await load();
    } catch (err: unknown) {
      setNotice(errorText(err));
    } finally {
      setReverting(false);
    }
  };

  const snapshotNow = async () => {
    setLoading(true);
    setError(null);
    try {
      setScope("turn");
      apply(await changesSnapshot(tabId));
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  const isAccepted = (item: ChangedFile) => accepted.has(acceptKey(item));

  let body;
  if (error) {
    body = <p className="error">{error}</p>;
  } else if (!set) {
    body = <p className="hint">Loading…</p>;
  } else if (set.state === "noRepo") {
    body = (
      <p className="hint">
        This folder is not in a git repository, so DCTerminal cannot track what changed.
      </p>
    );
  } else if (set.state === "noBaseline") {
    body = (
      <div className="changes-empty">
        <p className="hint">
          No snapshot yet. Chat tabs take one at the start of every prompt. Terminal tabs take
          one when you Send from the scratch pad; for commands typed straight into the terminal,
          take one before you start.
        </p>
        <button type="button" className="primary-button" onClick={() => void snapshotNow()}>
          Snapshot now
        </button>
      </div>
    );
  } else if (set.files.length === 0) {
    body = (
      <p className="hint">
        No changes since {timeLabel(set.baselineAt)}
        {scope === "turn" ? " (start of the last turn)." : " (first snapshot in this tab)."}
      </p>
    );
  } else {
    body = (
      <div className="changes-body">
        <ul className="changes-list" role="listbox" aria-label="Changed files">
          {set.files.map((item) => (
            <li
              key={item.path}
              role="option"
              aria-selected={item.path === selected}
              className={[
                "changes-item",
                item.path === selected ? "changes-item-selected" : "",
                isAccepted(item) ? "changes-item-accepted" : "",
              ].join(" ")}
              title={`${statusWord(item.status)}: ${item.path}`}
              onClick={() => setSelected(item.path)}
            >
              <span className={`changes-status changes-status-${item.status}`}>
                {statusLetter(item.status)}
              </span>
              <span className="changes-path">{item.path}</span>
              {item.binary ? (
                <span className="hint">bin</span>
              ) : (
                <span className="changes-counts">
                  <span className="diff-add-count">+{item.additions ?? 0}</span>
                  <span className="diff-del-count">−{item.deletions ?? 0}</span>
                </span>
              )}
              {isAccepted(item) && <span className="changes-accepted">✓ Accepted</span>}
            </li>
          ))}
        </ul>
        <div className="changes-detail">
          {file && (
            <div className="changes-file-bar">
              <strong className="changes-file-name" title={file.path}>
                {file.path}
              </strong>
              <span className="hint">{statusWord(file.status)}</span>
              <button
                type="button"
                className="secondary-button"
                disabled={isAccepted(file)}
                onClick={() => onAccept(acceptKey(file))}
                title="Keep the current version and mark it reviewed"
              >
                Accept
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || reverting}
                onClick={() => void revert([file])}
              >
                Revert file
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={!file.cwdPath || file.status === "deleted"}
                title={
                  file.status === "deleted"
                    ? "The file was deleted"
                    : file.cwdPath
                      ? undefined
                      : "Outside this tab's folder"
                }
                onClick={() => file.cwdPath && onOpenInFilePanel(file.cwdPath)}
              >
                Open in file panel
              </button>
            </div>
          )}
          {diffError && <p className="error">{diffError}</p>}
          {diff?.binary && <p className="hint">Binary file. No text diff.</p>}
          {diff && !diff.binary && hunks.length === 0 && (
            <p className="hint">Only the file mode changed.</p>
          )}
          {file && hunks.length > 0 && (
            <div className="diff-scroll">
              <table className="diff-table" aria-label={`Diff of ${file.path}`} data-view={view}>
                <tbody>
                  {hunks.map((hunk, h) => (
                    <Fragment key={h}>
                      <tr className="diff-hunk">
                        <td colSpan={view === "split" ? 4 : 3}>{hunk.header}</td>
                      </tr>
                      {view === "split"
                        ? toSplitRows(hunk).map((row, r) => (
                            <tr key={r}>
                              <Cell line={row.left} side="old" />
                              <Cell line={row.right} side="new" />
                            </tr>
                          ))
                        : hunk.lines.map((line, r) => (
                            <tr key={r}>
                              <td className="diff-no">{line.oldNo ?? ""}</td>
                              <td className="diff-no">{line.newNo ?? ""}</td>
                              <td className={`diff-text diff-${line.kind}`}>
                                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                                {line.text}
                              </td>
                            </tr>
                          ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {diff?.truncated && <p className="hint">The diff is too long; showing the start.</p>}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel changes-panel"
        role="dialog"
        aria-label={`Changes in ${tabLabel}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="changes-bar">
          <h3>Changes</h3>
          <span className="hint">{tabLabel}</span>
          <div className="segmented" role="radiogroup" aria-label="Changes since">
            {(["turn", "tab"] as const).map((value) => (
              <label key={value} className="segmented-option">
                <input
                  type="radio"
                  name="changes-scope"
                  checked={scope === value}
                  onChange={() => setScope(value)}
                />
                {value === "turn" ? "This turn" : "Whole tab"}
              </label>
            ))}
          </div>
          <div className="segmented" role="radiogroup" aria-label="Diff view">
            {(["unified", "split"] as const).map((value) => (
              <label key={value} className="segmented-option">
                <input
                  type="radio"
                  name="changes-view"
                  checked={view === value}
                  onChange={() => chooseView(value)}
                />
                {value === "unified" ? "Unified" : "Side by side"}
              </label>
            ))}
          </div>
          <span className="changes-bar-spacer" />
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => void snapshotNow()}
            title="Start counting changes from now"
          >
            New snapshot
          </button>
          <button
            type="button"
            className="secondary-button danger-button"
            disabled={busy || reverting || pending.length === 0}
            onClick={() => void revert(pending, (set?.files.length ?? 0) - pending.length)}
          >
            Revert all…
          </button>
          <button type="button" className="secondary-button" aria-label="Close changes" onClick={onClose}>
            ×
          </button>
        </div>
        {set?.state === "ok" && set.baselineAt && (
          <p className="hint changes-since">
            Since {timeLabel(set.baselineAt)}
            {scope === "turn" ? ", the start of the last turn." : ", the first snapshot in this tab."}
          </p>
        )}
        {busy && (
          <p className="hint changes-busy" role="status">
            The agent is still working in this tab. Revert is off until it finishes.
          </p>
        )}
        {notice && (
          <p className="hint changes-notice" role="status">
            {notice}
          </p>
        )}
        {body}
      </div>
    </div>
  );
}
