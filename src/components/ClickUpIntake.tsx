import { useCallback, useEffect, useId, useState, type MutableRefObject } from "react";
import { clickupIntakePreview, clickupIntakeStatus, type ClickUpIntakeStatus } from "../bridge";
import {
  PRIORITY_OPTIONS,
  filterChoices,
  filtersOf,
  isCurrent,
  overCapMessage,
  parsedDraft,
  previewSummary,
  togglePriority,
  toggleStatus,
  toggleTag,
  toggleTicket,
  type IntakeDraft,
} from "../clickup/intakeModel";
import type { RefProblem } from "../clickup/intakeRefs";
import { errorText, InlineNotice } from "./InlineNotice";

type Props = {
  /**
   * The box as Start will read it (`intakeStart`). The component keeps it
   * current and starts from it, so leaving the start screen keeps the
   * paste and the Fetch.
   */
  draftRef: MutableRefObject<IntakeDraft>;
  /** Opens Settings › Integrations, where this window's account gets a ClickUp token. */
  onOpenIntegrations: () => void;
  disabled?: boolean;
  /** F3: the box changed (the start screen counts the ticked tickets for its size suggestion). */
  onDraftChange?: (draft: IntakeDraft) => void;
};

/**
 * "Tickets from ClickUp" on the start screen (C2), shown when a pipeline
 * role starts a run: paste task and list links, Fetch, untick what the
 * round should not take, and Start uses the ticked tickets. ClickUp is read
 * with this window's Claude account only; Claude never sees the token.
 * The task text above stays as it is, so dictating still works.
 */
export function ClickUpIntake({ draftRef, onOpenIntegrations, disabled = false, onDraftChange }: Props) {
  const [status, setStatus] = useState<ClickUpIntakeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [draft, setDraftState] = useState<IntakeDraft>(() => draftRef.current);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchProblems, setFetchProblems] = useState<RefProblem[]>([]);
  const boxId = useId();

  const loadStatus = useCallback(
    (alive: () => boolean) =>
      clickupIntakeStatus()
        .then((next) => {
          if (!alive()) return;
          setStatus(next);
          setStatusError(null);
        })
        .catch((err: unknown) => {
          if (alive()) setStatusError(errorText(err));
        }),
    [],
  );
  // Asked again when the window comes back, so setting ClickUp up (in
  // Settings, which remounts this box when it closes, or in another
  // window) shows here without a restart.
  useEffect(() => {
    let alive = true;
    const isAlive = () => alive;
    void loadStatus(isAlive);
    const again = () => void loadStatus(isAlive);
    window.addEventListener("focus", again);
    return () => {
      alive = false;
      window.removeEventListener("focus", again);
    };
  }, [loadStatus]);

  const setDraft = (next: IntakeDraft) => {
    draftRef.current = next;
    setDraftState(next);
    onDraftChange?.(next);
  };

  if (statusError) return <InlineNotice tone="error">{statusError}</InlineNotice>;
  if (!status) return null;
  if (!status.configured) {
    return (
      <p className="hint clickup-intake-setup">
        To start from ClickUp tickets, set up ClickUp for {status.accountName}.{" "}
        <button type="button" className="link-button" onClick={onOpenIntegrations}>
          Open Settings › Integrations
        </button>
      </p>
    );
  }

  const parsed = parsedDraft(draft);
  const choices = filterChoices(draft);
  const current = isCurrent(draft);
  const preview = current ? draft.fetched?.preview : null;
  const problems = [...parsed.problems, ...(current ? fetchProblems : [])];

  const fetchNow = async () => {
    setFetchError(null);
    setFetchProblems([]);
    if (parsed.refs.length === 0) return;
    setFetching(true);
    try {
      const filters = filtersOf(draft);
      const next = await clickupIntakePreview(parsed.refs, filters);
      setDraft({ ...draftRef.current, fetched: { key: parsed.key, preview: next }, dropped: [] });
      setFetchProblems(next.problems);
    } catch (err) {
      setFetchError(errorText(err));
    } finally {
      setFetching(false);
    }
  };

  return (
    <section className="clickup-intake" aria-label="Tickets from ClickUp">
      <label className="field-label" htmlFor={boxId}>
        Tickets from ClickUp{" "}
        <span className="hint">
          ({status.workspaceName ?? "ClickUp"}, {status.accountName}): task or list links, or task ids, one or more per line
        </span>
      </label>
      <textarea
        id={boxId}
        rows={3}
        spellCheck={false}
        placeholder="https://app.clickup.com/t/86b1aa001"
        value={draft.text}
        disabled={disabled || fetching}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
      />
      <div className="clickup-intake-controls">
        <fieldset className="clickup-intake-priorities">
          <legend>Priority</legend>
          {PRIORITY_OPTIONS.map((option) => (
            <label key={option.id}>
              <input
                type="checkbox"
                checked={draft.priorities.includes(option.id)}
                disabled={disabled || fetching}
                onChange={(event) => setDraft(togglePriority(draft, option.id, event.target.checked))}
              />
              {option.label}
            </label>
          ))}
          <span className="hint">None ticked: every priority.</span>
        </fieldset>
        {choices.statuses.length > 0 && (
          <fieldset className="clickup-intake-priorities">
            <legend>Status</legend>
            {choices.statuses.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={draft.statuses.includes(name)}
                  disabled={disabled || fetching}
                  onChange={(event) => setDraft(toggleStatus(draft, name, event.target.checked))}
                />
                {name}
              </label>
            ))}
          </fieldset>
        )}
        {choices.tags.length > 0 && (
          <fieldset className="clickup-intake-priorities">
            <legend>Tags</legend>
            {choices.tags.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={draft.tags.includes(name)}
                  disabled={disabled || fetching}
                  onChange={(event) => setDraft(toggleTag(draft, name, event.target.checked))}
                />
                {name}
              </label>
            ))}
          </fieldset>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || fetching || parsed.refs.length === 0}
          onClick={() => void fetchNow()}
        >
          {fetching ? "Fetching…" : "Fetch"}
        </button>
      </div>
      {problems.length > 0 && (
        <ul className="clickup-intake-problems" aria-label="Lines not read">
          {problems.map((problem) => (
            <li key={`${problem.line}:${problem.message}`} className="error">
              {problem.message.startsWith("Line ") ? problem.message : `Line ${problem.line}: ${problem.message}`}
            </li>
          ))}
        </ul>
      )}
      {fetchError && <InlineNotice tone="error">{fetchError}</InlineNotice>}
      {draft.fetched && !current && (
        <p className="hint">The links or filters changed since Fetch. Press Fetch again before Start.</p>
      )}
      {current && overCapMessage(draft) && <InlineNotice tone="warning">{overCapMessage(draft)}</InlineNotice>}
      {preview && !preview.overCap && (
        <div className="clickup-intake-preview">
          {preview.parents.length > 0 && (
            <p className="hint">
              From{" "}
              {preview.parents.map((parent, index) => (
                <span key={`${parent.kind}:${parent.id}`}>
                  {index > 0 && ", "}
                  <strong>{parent.title}</strong> ({parent.tickets} {parent.kind === "list" ? "in the list" : "subtasks"})
                </span>
              ))}
            </p>
          )}
          <p className="hint" role="status">
            {previewSummary(draft)}
          </p>
          {preview.tickets.length > 0 && (
            <table className="clickup-intake-table" aria-label="Tickets to start with">
              <thead>
                <tr>
                  <th scope="col">Take</th>
                  <th scope="col">Ticket</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.tickets.map((ticket) => {
                  const ticked = !draft.dropped.includes(ticket.id);
                  return (
                    <tr key={ticket.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Take ${ticket.customId ?? ticket.id}: ${ticket.title}`}
                          checked={ticked}
                          disabled={disabled}
                          onChange={(event) => setDraft(toggleTicket(draft, ticket.id, event.target.checked))}
                        />
                      </td>
                      <td>
                        <code title={ticket.url}>{ticket.customId ?? ticket.id}</code>{" "}
                        {ticket.title}
                      </td>
                      <td>{ticket.priority}</td>
                      <td>{ticket.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {preview.excluded.length > 0 && (
            <div className="clickup-intake-excluded">
              <h4>Excluded</h4>
              <ul aria-label="Excluded tickets">
                {preview.excluded.map((ticket) => (
                  <li key={ticket.id}>
                    <code title={ticket.url}>{ticket.customId ?? ticket.id}</code>{" "}
                    {ticket.title}: <span className="hint">{ticket.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
