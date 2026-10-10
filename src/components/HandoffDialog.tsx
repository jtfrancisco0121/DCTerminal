import { useEffect, useMemo, useState } from "react";
import {
  composePlanText,
  defaultScope,
  handoffBlockReason,
  handoffFromRole,
  handoffTargets,
  isReportSource,
  mapHandoff,
  reportScopeHint,
  roleDisplayName,
  scopeChoices,
  type HandoffField,
  type HandoffScope,
  type HandoffSource,
  type HandoffSurface,
  type HandoffTargetId,
  type RoleName,
} from "../handoff/map";
import { loopBackMessage } from "../handoff/routing";

/** A chain reviewer sending its round back to an earlier stage. */
export type LoopBackTarget = {
  /** Round the reviewer is ending. */
  round: number;
  /** The chain's tab for the target role; null when it is closed. */
  tabLabel: string | null;
  /** That tab's session is live: the findings go in there as a follow-up. */
  live: boolean;
  /** Why the follow-up cannot go yet (the tab is mid-turn). */
  blocked: string | null;
};

type Props = {
  source: HandoffSource;
  targetRoleId: HandoffTargetId;
  targetFields: HandoffField[] | null;
  folderWarning: string | null;
  busy: boolean;
  error: string | null;
  preferredSurface: HandoffSurface;
  /** Loaded roles, for display names and hand-off targets. Built-ins are used when absent. */
  roleNames?: readonly RoleName[] | null;
  /** Set when the chosen target is this chain's loop-back. */
  loopBack?: LoopBackTarget | null;
  /** On a chain, Start fills the task type from the chain's first form. */
  chainFillsTaskType?: boolean;
  onTarget: (id: HandoffTargetId) => void;
  onConfirm: (scope: HandoffScope, surface: HandoffSurface) => void;
  onClose: () => void;
};

export function HandoffDialog({
  source,
  targetRoleId,
  targetFields,
  folderWarning,
  busy,
  error,
  preferredSurface,
  roleNames = null,
  loopBack = null,
  chainFillsTaskType = false,
  onTarget,
  onConfirm,
  onClose,
}: Props) {
  const targets = handoffTargets(source.sourceRoleId, roleNames).map((id) => ({
    id,
    label: roleDisplayName(id, roleNames),
  }));
  // Until the user picks, the default follows the source: a plan file read
  // after the dialog opened, or a reply that finished meanwhile, takes over.
  const [pickedScope, setScope] = useState<HandoffScope | null>(null);
  const [surface, setSurface] = useState<HandoffSurface>(preferredSurface);
  useEffect(() => {
    setSurface(preferredSurface);
  }, [preferredSurface, targetRoleId]);
  const choices = scopeChoices(source);
  const scope =
    pickedScope && choices.some((choice) => choice.id === pickedScope && choice.enabled)
      ? pickedScope
      : defaultScope(source);
  const block = handoffBlockReason(source, roleNames);
  const mapped = useMemo(
    () =>
      mapHandoff(source, scope, {
        roleId: targetRoleId,
        fields: targetFields ?? [],
      }),
    [source, scope, targetRoleId, targetFields],
  );
  const preview = composePlanText(source, scope).text;
  const previewText = Array.from(preview).slice(0, 500).join("");
  const targetLabel = roleDisplayName(targetRoleId, roleNames);
  const followUp = loopBack?.live ? loopBack : null;
  const heading = followUp
    ? `Send back to ${targetLabel}`
    : isReportSource(source.sourceRoleId)
      ? "Send for planning"
      : "Send plan";
  const scopeHint =
    targetRoleId === "role_planner" ? reportScopeHint(source, scope) : null;
  const message = followUp
    ? loopBackMessage(source.sourceRoleId, preview, followUp.round, roleNames)
    : "";
  // Required target fields the hand-off cannot fill: say so now, not at Start.
  const missing =
    followUp || !targetFields || !mapped.planText
      ? []
      : targetFields
          .filter((field) => field.required && field.key !== "cwd")
          .filter((field) => !(chainFillsTaskType && field.key === "taskType"))
          .filter((field) => !(mapped.answers[field.key] ?? "").trim())
          .map((field) => field.label?.trim() || field.key);
  const canConfirm = followUp
    ? !busy && !block && !followUp.blocked && preview.trim().length > 0
    : !busy && !block && mapped.planText.length > 0 && targetFields !== null;

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel"
        role="dialog"
        aria-label={heading}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{heading}</h2>
        {followUp ? (
          <>
            <p className="hint">
              Sends the review findings below as a follow-up message in the chain's existing{" "}
              {targetLabel} tab. Round {followUp.round + 1} starts. Nothing else is sent.
            </p>
            <p className="handoff-target" aria-label="Target tab">
              To tab: <strong>{followUp.tabLabel}</strong>
            </p>
          </>
        ) : (
          <p className="hint">
            {surface === "terminal"
              ? "Starts the role in a terminal tab (Claude Code or Cursor CLI, per the tab's provider) with the hand-off text as the first prompt."
              : "Opens a new tab in the same folder with the hand-off text filled in. Review it, then press Start. Nothing starts on its own."}
          </p>
        )}
        {loopBack && !followUp && (
          <p className="hint">
            {loopBack.tabLabel
              ? `The chain's ${targetLabel} tab has no live session, so a new tab opens on the chain (round ${loopBack.round + 1}).`
              : `The chain's ${targetLabel} tab is closed, so a new tab opens on the chain (round ${loopBack.round + 1}).`}
          </p>
        )}
        <fieldset className="handoff-fieldset">
          <legend>Send to</legend>
          {targets.map((target) => (
            <label key={target.id} className="handoff-choice">
              <input
                type="radio"
                name="handoff-target"
                checked={targetRoleId === target.id}
                onChange={() => onTarget(target.id)}
                disabled={busy}
              />
              <span>{target.label}</span>
            </label>
          ))}
        </fieldset>
        {!followUp && (
        <fieldset className="handoff-fieldset">
          <legend>Open as</legend>
          <label className="handoff-choice">
            <input
              type="radio"
              name="handoff-surface"
              checked={surface === "chat"}
              onChange={() => setSurface("chat")}
              disabled={busy}
            />
            <span>Chat</span>
          </label>
          <label className="handoff-choice">
            <input
              type="radio"
              name="handoff-surface"
              checked={surface === "terminal"}
              onChange={() => setSurface("terminal")}
              disabled={busy}
            />
            <span>Terminal</span>
          </label>
        </fieldset>
        )}
        <fieldset className="handoff-fieldset">
          <legend>What to send</legend>
          {choices.map((choice) => (
            <label key={choice.id} className="handoff-choice">
              <input
                type="radio"
                name="handoff-scope"
                checked={scope === choice.id}
                onChange={() => setScope(choice.id)}
                disabled={busy || !choice.enabled}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </fieldset>
        {!followUp && folderWarning && <p className="error">{folderWarning} You can still open the tab and pick another folder before Start.</p>}
        {block && <p className="hint">{block}</p>}
        {followUp?.blocked && <p className="hint">{followUp.blocked}</p>}
        {scopeHint && <p className="hint">{scopeHint}</p>}
        {!followUp && mapped.warning && <p className="hint">{mapped.warning}</p>}
        {missing.length > 0 && (
          <p className="hint" role="note" aria-label="Fields to fill in">
            The {targetLabel} tab opens with {missing.join(", ")} empty. Fill{" "}
            {missing.length > 1 ? "them" : "it"} in before Start.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {followUp && preview.trim() && (
          <pre
            className="mono-snippet handoff-preview handoff-preview-full"
            aria-label="Follow-up message"
          >
            {message}
          </pre>
        )}
        {!followUp && previewText && (
          <pre className="mono-snippet handoff-preview">
            {previewText}
            {preview.length > previewText.length ? "…" : ""}
          </pre>
        )}
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canConfirm}
            onClick={() => onConfirm(scope, surface)}
          >
            {busy
              ? followUp
                ? "Sending…"
                : "Opening…"
              : followUp
                ? `Send follow-up to ${followUp.tabLabel}`
                : surface === "terminal"
                ? `Start ${targetLabel} terminal`
                : `Open ${targetLabel} tab`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function HandoffActions({
  enabled,
  reason,
  busy = false,
  sourceRoleId,
  targets,
  primaryTarget = null,
  primaryLabel = null,
  completeNote = null,
  roleNames = null,
  onSend,
}: {
  enabled: boolean;
  reason: string | null;
  busy?: boolean;
  /** Buttons follow this role's row in the transition table. */
  sourceRoleId?: string;
  /** Explicit targets; overrides `sourceRoleId`. */
  targets?: HandoffTargetId[];
  /** Chain's next role, or where the verdict points. That button is primary. */
  primaryTarget?: string | null;
  /** Primary button text; default "Next: Send to …". */
  primaryLabel?: string | null;
  /** Shown when nothing is left to hand on (PR Reviewer approved). */
  completeNote?: string | null;
  roleNames?: readonly RoleName[] | null;
  onSend: (target: HandoffTargetId) => void;
}) {
  const ids = targets ?? (sourceRoleId ? handoffTargets(sourceRoleId, roleNames) : []);
  return (
    <div className="button-row handoff-actions">
      {completeNote && <span className="handoff-complete">{completeNote}</span>}
      {ids.map((id) => {
        const name = roleDisplayName(id, roleNames);
        const primary = id === primaryTarget;
        return (
          <button
            key={id}
            type="button"
            className={primary ? "primary-button" : "secondary-button"}
            disabled={!enabled || busy}
            title={reason ?? `Open a ${name} tab with this hand-off`}
            onClick={() => onSend(id)}
          >
            {primary ? (primaryLabel ?? `Next: Send to ${name}`) : `Send to ${name}`}
          </button>
        );
      })}
    </div>
  );
}

export function HandoffBanner({
  sourceRoleId,
  title,
  warning,
  roleNames = null,
  onOpen,
}: {
  sourceRoleId: string;
  roleNames?: readonly RoleName[] | null;
  title: string;
  warning: string | null;
  onOpen: () => void;
}) {
  return (
    <p className="handoff-banner">
      From {handoffFromRole(sourceRoleId, roleNames)}:{" "}
      <button type="button" className="link-button" onClick={onOpen}>
        {title}
      </button>
      {warning ? <span className="hint"> {warning}</span> : null}
    </p>
  );
}

export function SavedPlanDialog({
  title,
  cwd,
  createdAt,
  planText,
  loading,
  error,
  onClose,
}: {
  title: string;
  cwd: string;
  createdAt: string;
  planText: string;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel"
        role="dialog"
        aria-label="Saved plan"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        <p className="hint">
          {createdAt}
          {cwd ? ` · ${cwd}` : ""}
        </p>
        <p className="hint">The Planner tab is closed. This copy is stored in app data.</p>
        {loading && <p className="hint">Loading the saved plan…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && <pre className="mono-snippet handoff-preview handoff-preview-full">{planText}</pre>}
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
