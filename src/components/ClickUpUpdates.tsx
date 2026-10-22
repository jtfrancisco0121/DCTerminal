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
  type ClickUpSendRow,
  type ClickUpWritebackView,
} from "../bridge";
import { useConfirm } from "./confirm";
import { errorText, InlineNotice } from "./InlineNotice";

type Props = {
  runId: string;
  /** Changes when the run does (a verification, the run completing), to rebuild the proposals. */
  refreshKey: string;
};

/** A row already sent, unchanged since: sending it again would repeat it (C3). */
export function sentAsIs(p: ClickUpProposal): boolean {
  return !!p.sent && p.sent.comment === p.comment && (p.status == null || p.sent.status === p.status);
}

/** The rows Send ticked would post: ticked, not skipped, not already sent as they are. */
export function rowsToSend(proposals: ClickUpProposal[]): ClickUpProposal[] {
  return proposals.filter((p) => p.ticked && !p.skipped && !p.sentMaybe && !sentAsIs(p));
}

/** What Send carries for each row: exactly what you see, so a row that changed since is not sent. */
export function sendRows(proposals: ClickUpProposal[]): ClickUpSendRow[] {
  return rowsToSend(proposals).map((p) => ({ ticketId: p.ticket.id, comment: p.comment, status: p.status ?? null }));
}

/** "Sent 2 updates." / "Sent 1 update. 1 failed: see its row." / "… 1 not sent: …" */
export function sendResultText(sent: number, failed: number, notSent: { ticketId: string; reason: string }[] = []): string {
  const parts = [`Sent ${sent} update${sent === 1 ? "" : "s"}.`];
  if (failed > 0) parts.push(`${failed} failed: see ${failed === 1 ? "its row" : "their rows"}.`);
  for (const row of notSent) parts.push(`${row.ticketId} not sent: ${row.reason}`);
  return parts.join(" ");
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
  const confirm = useConfirm();
  const [view, setView] = useState<ClickUpWritebackView | null>(null);
  // The latest view, for a Send queued behind a comment saved on blur:
  // set as soon as each load or edit returns, before React renders it.
  const viewRef = useRef(view);
  viewRef.current = view;
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
      const next = await clickupWritebackLoad(runId);
      viewRef.current = next;
      setView(next);
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
        const next = await clickupWritebackEdit(runId, ticketId, change);
        viewRef.current = next;
        setView(next);
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

  const tick = async (p: ClickUpProposal, ticked: boolean) => {
    const comment = pendingComment(p);
    const change: ClickUpRowEdit = { ticked, ...(comment !== undefined ? { comment } : {}) };
    if (ticked && p.sentMaybe) {
      const ok = await confirm({
        title: "Send this update again?",
        message:
          "Its last send timed out, so ClickUp may have posted the comment anyway. Check the ticket in ClickUp first, so it is not posted twice.",
        confirmLabel: "Send again",
      });
      if (!ok) return;
      change.confirmResend = true;
    }
    await edit(p.ticket.id, change);
  };

  const send = () =>
    serial(async () => {
      const rows = sendRows(viewRef.current?.proposals ?? []);
      if (rows.length === 0) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await clickupWritebackSend(runId, rows);
        viewRef.current = result.view;
        setView(result.view);
        setNotice(sendResultText(result.sent, result.failed, result.notSent));
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
          const alreadySent = sentAsIs(p) && pendingComment(p) === undefined;
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
                    disabled={locked || !!p.skipped || (alreadySent && !p.ticked)}
                    title={alreadySent ? "Already sent. Edit the comment or status to send it again." : undefined}
                    onChange={(event) => void tick(p, event.target.checked)}
                  />
                  Send
                </label>
                <a href={p.ticket.url} target="_blank" rel="noreferrer">
                  <code>{name}</code>
                </a>{" "}
                <span>{p.ticket.title}</span>
                {p.followUp && <span className="hint"> · Follow-up</span>}
                {p.sent && (
                  <span className="hint">
                    {" "}
                    · Sent {when(p.sent.at)}
                    {p.sent.comment ? "" : ", status only"}
                    {p.sent.status ? `, status ${p.sent.status}` : ""}
                  </span>
                )}
                {p.sentMaybe && <span className="hint"> · May have been posted: check the ticket</span>}
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
