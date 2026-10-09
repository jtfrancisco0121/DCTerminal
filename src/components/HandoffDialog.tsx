import { useEffect, useMemo, useState } from "react";
import {
  composePlanText,
  defaultScope,
  handoffBlockReason,
  handoffFromRole,
  handoffTargets,
  mapHandoff,
  roleDisplayName,
  scopeChoices,
  type HandoffField,
  type HandoffScope,
  type HandoffSource,
  type HandoffSurface,
  type HandoffTargetId,
  type RoleName,
} from "../handoff/map";

type Props = {
  source: HandoffSource;
  targetRoleId: HandoffTargetId;
  targetFields: HandoffField[] | null;
  folderWarning: string | null;
  busy: boolean;
  error: string | null;
  preferredSurface: HandoffSurface;
  /** Loaded roles, for display names. Built-in names are used when absent. */
  roleNames?: readonly RoleName[] | null;
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
  onTarget,
  onConfirm,
  onClose,
}: Props) {
  const targets = handoffTargets(source.sourceRoleId).map((id) => ({
    id,
    label: roleDisplayName(id, roleNames),
  }));
  const [scope, setScope] = useState<HandoffScope>(() => defaultScope(source));
  const [surface, setSurface] = useState<HandoffSurface>(preferredSurface);
  useEffect(() => {
    setSurface(preferredSurface);
  }, [preferredSurface, targetRoleId]);
  const choices = scopeChoices(source);
  const block = handoffBlockReason(source);
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
  const canConfirm = !busy && !block && mapped.planText.length > 0 && targetFields !== null;

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel"
        role="dialog"
        aria-label="Send plan"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Send plan</h2>
        <p className="hint">
          {surface === "terminal"
            ? "Starts the role in a terminal tab (Claude Code or Cursor CLI, per the tab's provider) with the hand-off text as the first prompt."
            : "Opens a new tab in the same folder with the hand-off text filled in. Review it, then press Start. Nothing starts on its own."}
        </p>
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
        {folderWarning && <p className="error">{folderWarning} You can still open the tab and pick another folder before Start.</p>}
        {block && <p className="hint">{block}</p>}
        {mapped.warning && <p className="hint">{mapped.warning}</p>}
        {error && <p className="error">{error}</p>}
        {previewText && (
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
              ? "Opening…"
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
  /** Chain's next role. That button is the primary "Next:" action. */
  primaryTarget?: string | null;
  roleNames?: readonly RoleName[] | null;
  onSend: (target: HandoffTargetId) => void;
}) {
  const ids = targets ?? (sourceRoleId ? handoffTargets(sourceRoleId) : []);
  return (
    <div className="button-row handoff-actions">
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
            {primary ? `Next: Send to ${name}` : `Send to ${name}`}
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
