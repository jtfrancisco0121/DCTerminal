import { useCallback, useEffect, useRef, useState } from "react";
import {
  clickupListStatuses,
  clickupStatusMapSet,
  clickupWritebackEdit,
  clickupWritebackLoad,
  clickupWritebackSend,
  type ClickUpListStatus,
  type ClickUpProposal,
  type ClickUpRowEdit,
  type ClickUpWritebackView,
} from "../bridge";
import { errorText, InlineNotice } from "./InlineNotice";

type Props = {
  runId: string;
  /** Changes when the run does (a verification, the run completing), to rebuild the proposals. */
  refreshKey: string;
};

/** A row already sent, unchanged since: sending it again would repeat it (C3). */
export function sentAsIs(p: ClickUpProposal): boolean {
  return !!p.sent && p.sent.comment === p.comment && (p.sent.status ?? null) === (p.status ?? null);
}

/** The rows Send ticked would post: ticked, not skipped, not already sent as they are. */
export function rowsToSend(proposals: ClickUpProposal[]): ClickUpProposal[] {
  return proposals.filter((p) => p.ticked && !p.skipped && !sentAsIs(p));
}

/** "Sent 2 updates." / "Sent 1 update. 1 failed: see its row." */
export function sendResultText(sent: number, failed: number): string {
  const sentText = `Sent ${sent} update${sent === 1 ? "" : "s"}.`;
  if (failed === 0) return sentText;
  return `${sentText} ${failed} failed: see ${failed === 1 ? "its row" : "their rows"}.`;
}

function when(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

type ListStatuses = { statuses: ClickUpListStatus[] } | { error: string };

/**
 * "ClickUp updates" on the chain overview (C3). Once a lane is marked
 * verified or the run completes, each ticket from the run's tickets.json
 * gets a proposed comment (the pull requests, what changed, how it was
 * verified) and, for a verified ticket, its list's mapped status. Nothing
 * is ticked for you, and **Send ticked** posts only the ticked rows, with
 * the Claude account the tickets were taken with. Renders nothing for a
 * run with no tickets.json or nothing due yet.
 */
export function ClickUpUpdates({ runId, refreshKey }: Props) {
  const [view, setView] = useState<ClickUpWritebackView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, ListStatuses>>({});
  // Edits and sends go one at a time, in order, so a comment committed on
  // blur always lands before the Send its click started.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const serial = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const load = useCallback(async () => {
    try {
      setView(await clickupWritebackLoad(runId));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [runId]);

  useEffect(() => {
    void serial(load);
  }, [load, refreshKey, serial]);

  // Each list's real statuses, read once (C3: the picker offers only these).
  const accountId = view?.accountId;
  const listIds = (view?.lists ?? []).map((l) => l.id).join(",");
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!accountId || !listIds) return;
    for (const listId of listIds.split(",")) {
      const key = `${accountId}/${listId}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      clickupListStatuses(accountId, listId)
        .then((list) => setStatuses((prev) => ({ ...prev, [listId]: { statuses: list.statuses } })))
        .catch((err: unknown) => setStatuses((prev) => ({ ...prev, [listId]: { error: errorText(err) } })));
    }
  }, [accountId, listIds]);

  const edit = (ticketId: string, change: ClickUpRowEdit) =>
    serial(async () => {
      setError(null);
      setNotice(null);
      try {
        setView(await clickupWritebackEdit(runId, ticketId, change));
        if (change.comment !== undefined) {
          setDrafts((prev) => {
            const next = { ...prev };
            delete next[ticketId];
            return next;
          });
        }
      } catch (err) {
        setError(errorText(err));
      }
    });

  /** The row's comment edit, when you typed one that is not saved yet. */
  const pendingComment = (p: ClickUpProposal): string | undefined => {
    const draft = drafts[p.ticket.id];
    return draft !== undefined && draft.trim() !== p.comment ? draft : undefined;
  };

  const send = () =>
    serial(async () => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await clickupWritebackSend(runId);
        setView(result.view);
        setNotice(sendResultText(result.sent, result.failed));
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(false);
      }
    });

  const mapList = (listId: string, verified: string) =>
    serial(async () => {
      if (!view) return;
      setError(null);
      try {
        await clickupStatusMapSet(view.accountId, listId, verified || null);
        await load();
      } catch (err) {
        setError(errorText(err));
      }
    });

  if (!view) {
    return error ? (
      <InlineNotice className="pipeline-intake" tone="warning">
        Could not load the ClickUp updates: {error}
      </InlineNotice>
    ) : null;
  }
  if (view.proposals.length === 0) return null;

  const ticked = rowsToSend(view.proposals).length;
  const locked = busy || !!view.sending;

  return (
    <section className="pipeline-intake clickup-updates" aria-label="ClickUp updates">
      <h3>ClickUp updates</h3>
      <p className="hint">
        One update per ticket, sent with {view.accountName}&apos;s ClickUp. Nothing is sent until
        you tick it and press Send ticked.
      </p>
      {view.lists.length > 0 && (
        <div className="clickup-update-maps" role="group" aria-label="Verified status per list">
          {view.lists.map((list) => {
            const read = statuses[list.id];
            return (
              <label key={list.id} className="field-label settings-inline-field">
                <span>Verified status for {list.name}</span>
                <select
                  aria-label={`Verified status for ${list.name}`}
                  value={list.verified ?? ""}
                  disabled={locked || !read || "error" in read}
                  onChange={(event) => void mapList(list.id, event.target.value)}
                >
                  <option value="">Not mapped</option>
                  {read && "statuses" in read
                    ? read.statuses.map((s) => (
                        <option key={s.status} value={s.status}>
                          {s.status}
                        </option>
                      ))
                    : list.verified && <option value={list.verified}>{list.verified}</option>}
                </select>
                {read && "error" in read && <span className="hint">Could not read its statuses: {read.error}</span>}
              </label>
            );
          })}
        </div>
      )}
      <ul className="clickup-update-rows">
        {view.proposals.map((p) => {
          const id = p.ticket.id;
          const name = p.ticket.customId ?? id;
          const read = p.ticket.list ? statuses[p.ticket.list.id] : undefined;
          const options = read && "statuses" in read ? read.statuses.map((s) => s.status) : [];
          if (p.status && !options.includes(p.status)) options.unshift(p.status);
          const draft = drafts[id];
          const unsent = sentAsIs(p) && pendingComment(p) === undefined;
          return (
            <li
              key={id}
              className={`clickup-update${p.skipped ? " clickup-update-skipped" : ""}`}
              aria-label={`ClickUp update for ${name}`}
            >
              <div className="clickup-update-head">
                <label className="eagle-toggle">
                  <input
                    type="checkbox"
                    checked={p.ticked && !p.skipped}
                    disabled={locked || !!p.skipped || (unsent && !p.ticked)}
                    title={unsent ? "Already sent. Edit the comment or status to send it again." : undefined}
                    onChange={(event) => {
                      const comment = pendingComment(p);
                      void edit(id, { ticked: event.target.checked, ...(comment !== undefined ? { comment } : {}) });
                    }}
                  />
                  Send
                </label>
                <a href={p.ticket.url} target="_blank" rel="noreferrer">
                  <code>{name}</code>
                </a>{" "}
                <span>{p.ticket.title}</span>
                {p.sent && (
                  <span className="hint">
                    {" "}
                    · Sent {when(p.sent.at)}
                    {p.sent.status ? `, status ${p.sent.status}` : ""}
                  </span>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => void edit(id, { skipped: !p.skipped })}
                >
                  {p.skipped ? "Take back" : "Skip"}
                </button>
              </div>
              {!p.skipped && (
                <>
                  <textarea
                    aria-label={`Comment for ${name}`}
                    rows={6}
                    value={draft ?? p.comment}
                    disabled={locked}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDrafts((prev) => ({ ...prev, [id]: value }));
                    }}
                    onBlur={() => {
                      const comment = pendingComment(p);
                      if (comment !== undefined) void edit(id, { comment });
                    }}
                  />
                  <label className="field-label settings-inline-field">
                    <span>Status</span>
                    <select
                      aria-label={`Status for ${name}`}
                      value={p.status ?? ""}
                      disabled={locked}
                      onChange={(event) => void edit(id, { setStatus: true, status: event.target.value || null })}
                    >
                      <option value="">No status change</option>
                      {options.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>
                  {p.statusNote && !p.status && <p className="hint">{p.statusNote}</p>}
                </>
              )}
              {p.error && <InlineNotice tone="error">Not sent: {p.error}</InlineNotice>}
            </li>
          );
        })}
      </ul>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {notice && <InlineNotice>{notice}</InlineNotice>}
      <div className="button-row">
        <button
          type="button"
          className="primary-button"
          disabled={locked || ticked === 0}
          title={ticked === 0 ? "Tick the updates to send first." : undefined}
          onClick={() => void send()}
        >
          {locked ? "Sending…" : `Send ticked (${ticked})`}
        </button>
      </div>
    </section>
  );
}
