import { useMemo, useState } from "react";
import {
  composePlanText,
  defaultScope,
  handoffBlockReason,
  handoffFromRole,
  mapHandoff,
  scopeChoices,
  type HandoffField,
  type HandoffScope,
  type HandoffSource,
  type HandoffTargetId,
} from "../handoff/map";

const TARGETS: { id: HandoffTargetId; label: string }[] = [
  { id: "role_implementer", label: "Implementer" },
  { id: "role_developer", label: "Developer" },
];

type Props = {
  source: HandoffSource;
  targetRoleId: HandoffTargetId;
  targetFields: HandoffField[] | null;
  folderWarning: string | null;
  busy: boolean;
  error: string | null;
  onTarget: (id: HandoffTargetId) => void;
  onConfirm: (scope: HandoffScope) => void;
  onClose: () => void;
};

export function HandoffDialog({
  source,
  targetRoleId,
  targetFields,
  folderWarning,
  busy,
  error,
  onTarget,
  onConfirm,
  onClose,
}: Props) {
  const [scope, setScope] = useState<HandoffScope>(() => defaultScope(source));
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
  const targetLabel = TARGETS.find((item) => item.id === targetRoleId)?.label ?? "role";
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
          Opens a new tab in the same folder with the plan filled in. Review it, then press
          Start. Nothing starts on its own.
        </p>
        <fieldset className="handoff-fieldset">
          <legend>Send to</legend>
          {TARGETS.map((target) => (
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
            onClick={() => onConfirm(scope)}
          >
            {busy ? "Opening…" : `Open ${targetLabel} tab`}
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
  onSend,
}: {
  enabled: boolean;
  reason: string | null;
  busy?: boolean;
  onSend: (target: HandoffTargetId) => void;
}) {
  return (
    <div className="button-row handoff-actions">
      <button
        type="button"
        className="secondary-button"
        disabled={!enabled || busy}
        title={reason ?? "Open an Implementer tab with this plan"}
        onClick={() => onSend("role_implementer")}
      >
        Send to Implementer
      </button>
      <button
        type="button"
        className="secondary-button"
        disabled={!enabled || busy}
        title={reason ?? "Open a Developer tab with this plan"}
        onClick={() => onSend("role_developer")}
      >
        Send to Developer
      </button>
    </div>
  );
}

export function HandoffBanner({
  sourceRoleId,
  title,
  warning,
  onOpen,
}: {
  sourceRoleId: string;
  title: string;
  warning: string | null;
  onOpen: () => void;
}) {
  return (
    <p className="handoff-banner">
      From {handoffFromRole(sourceRoleId)}:{" "}
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
