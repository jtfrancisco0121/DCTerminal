import { useEffect, useState } from "react";
import {
  createRole,
  deleteRole,
  duplicateRole,
  getRole,
  previewRoleTemplate,
  resetBuiltinRole,
  saveRole,
  type Role,
  type RoleSummary,
  type TemplatePreview,
} from "../bridge";
import { runRoleExport, runRoleImport } from "../export/runRoleTransfer";
import { handoffTargets, roleDisplayName } from "../handoff/transitions";
import { CHIP_COLORS } from "../TabBar";
import { rolePermissionSummary } from "../workspaceView";

/** Cursor chat modes a role can start in. Claude modes follow the locked per-role rules. */
export const ROLE_MODES: { id: string; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
];

const PREVIEW_DELAY_MS = 300;

type Props = {
  roles: RoleSummary[];
  onRefreshRoles?: () => Promise<void>;
};

type Draft = {
  name: string;
  color: string;
  mode: string;
  template: string;
  targets: string[];
};

function draftFrom(role: Role): Draft {
  return {
    name: role.name,
    color: role.color,
    mode: role.defaultMode,
    template: role.templateText,
    targets: handoffTargets(role.id, [role]),
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Settings > Roles: pick a role, edit it, and manage custom roles. */
export function RoleEditor({ roles, onRefreshRoles }: Props) {
  const [selectedId, setSelectedId] = useState(roles[0]?.id ?? "");
  const [detail, setDetail] = useState<Role | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    getRole(selectedId)
      .then((role) => {
        if (cancelled) return;
        setDetail(role);
        setDraft(draftFrom(role));
        setPreview(null);
        setConfirmDelete(false);
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(null);
          setDraft(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const template = draft?.template;
  const detailId = detail?.id;
  useEffect(() => {
    if (!detailId || template === undefined) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => previewRoleTemplate(detailId, template))
        .then((next) => {
          if (!cancelled) setPreview(next);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [detailId, template]);

  const loaded = (role: Role, note: string) => {
    setDetail(role);
    setDraft(draftFrom(role));
    setNotice(note);
  };

  /** Runs one editor action with the buttons disabled and errors shown. */
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (err: unknown) {
      setNotice(message(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      if (!detail || !draft) return;
      const initialTargets = handoffTargets(detail.id, [detail]);
      const updated = await saveRole({
        roleId: detail.id,
        templateText: draft.template,
        name: draft.name,
        color: draft.color,
        defaultMode: draft.mode,
        // Unchanged built-in targets stay on the built-in table.
        ...(sameList(draft.targets, initialTargets) ? {} : { handoffTargets: draft.targets }),
      });
      loaded(updated, "Saved.");
      await onRefreshRoles?.();
    });

  const reset = () =>
    act(async () => {
      if (!detail?.isBuiltIn) return;
      loaded(await resetBuiltinRole(detail.id), "Reset to built-in template.");
      await onRefreshRoles?.();
    });

  /** Adds a role, refreshes the list, then selects it. */
  const added = async (role: Role, note: string) => {
    await onRefreshRoles?.();
    setSelectedId(role.id);
    loaded(role, note);
  };

  const duplicate = () =>
    act(async () => {
      if (!detail || !draft) return;
      const copy = await duplicateRole(detail.id, handoffTargets(detail.id, [detail]));
      await added(copy, `Duplicated as ${copy.name}.`);
    });

  const create = () =>
    act(async () => {
      await added(await createRole("New role"), "New role added. Edit it, then Save.");
    });

  const remove = () =>
    act(async () => {
      if (!detail || detail.isBuiltIn) return;
      const name = detail.name;
      await deleteRole(detail.id);
      setConfirmDelete(false);
      await onRefreshRoles?.();
      const next = roles.find((role) => role.id !== detail.id)?.id ?? "";
      setDetail(null);
      setDraft(null);
      setSelectedId(next);
      setNotice(`Deleted ${name}.`);
    });

  const exportOne = () =>
    act(async () => {
      if (!detail) return;
      const result = await runRoleExport(detail);
      setNotice(result.ok ? `Exported to ${result.path}.` : result.message);
    });

  const importOne = () =>
    act(async () => {
      const result = await runRoleImport();
      if (!result.ok) {
        setNotice(result.message);
        return;
      }
      await added(result.role, `Imported ${result.role.name}.`);
    });

  const patch = (next: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...next } : prev));

  const toggleTarget = (id: string, on: boolean) => {
    if (!draft) return;
    // "Send to …" buttons follow this order; a newly ticked role goes last.
    const kept = draft.targets.filter((target) => target !== id);
    patch({ targets: on ? [...kept, id] : kept });
  };

  const others = roles.filter((role) => role.id !== detail?.id);

  return (
    <section className="settings-section" aria-label="Roles">
      <h3>Roles</h3>
      <ul className="settings-role-list">
        {roles.map((role) => (
          <li key={role.id}>
            <button
              type="button"
              className={
                role.id === selectedId ? "settings-role settings-role-active" : "settings-role"
              }
              onClick={() => {
                setNotice(null);
                setSelectedId(role.id);
              }}
            >
              <span className="role-dot" style={{ background: role.color }} aria-hidden />
              <span>{role.name}</span>
              <span className="hint">
                {role.isBuiltIn === false ? "custom · " : ""}
                {role.defaultMode} · {role.fieldCount} fields
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void create()}>
          New role
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void importOne()}>
          Import…
        </button>
      </div>
      {detail && draft && (
        <div className="settings-role-detail">
          <p>
            <strong>{detail.name}</strong> · {detail.isBuiltIn ? "built-in" : "custom"} ·{" "}
            {detail.defaultMode} · {detail.fields.length} fields
          </p>
          <p className="hint">{rolePermissionSummary(detail.id)}</p>
          <label className="field-label" htmlFor="settings-role-name">
            Name
          </label>
          <input
            id="settings-role-name"
            className="text-input"
            value={draft.name}
            disabled={busy}
            onChange={(event) => patch({ name: event.target.value })}
          />
          <fieldset className="role-editor-fieldset">
            <legend>Color</legend>
            <div className="role-color-row">
              {CHIP_COLORS.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="role-color-swatch"
                  style={{ background: choice }}
                  aria-label={`Color ${choice}`}
                  aria-pressed={draft.color.toLowerCase() === choice}
                  disabled={busy}
                  onClick={() => patch({ color: choice })}
                />
              ))}
            </div>
          </fieldset>
          <label className="field-label" htmlFor="settings-role-mode">
            Default mode
          </label>
          <select
            id="settings-role-mode"
            className="text-input"
            value={draft.mode}
            disabled={busy}
            onChange={(event) => patch({ mode: event.target.value })}
          >
            {ROLE_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
          <fieldset className="role-editor-fieldset">
            <legend>Hand-off targets</legend>
            {others.length === 0 && <p className="hint">No other roles.</p>}
            {others.map((role) => (
              <label key={role.id} className="handoff-choice">
                <input
                  type="checkbox"
                  checked={draft.targets.includes(role.id)}
                  disabled={busy}
                  onChange={(event) => toggleTarget(role.id, event.target.checked)}
                />
                <span>{roleDisplayName(role.id, roles)}</span>
              </label>
            ))}
            <p className="hint">
              &quot;Send to …&quot; offers these roles. A hand-off fills the target&apos;s
              matching fields, or the scratch pad when it has none.
            </p>
          </fieldset>
          <label className="field-label" htmlFor="settings-role-template">
            Role template
          </label>
          <textarea
            id="settings-role-template"
            className="settings-role-template"
            rows={14}
            value={draft.template}
            disabled={busy}
            onChange={(event) => patch({ template: event.target.value })}
          />
          <div className="role-template-preview" aria-label="Template fields" role="status">
            {preview?.error ? (
              <p className="error">{preview.error}</p>
            ) : preview ? (
              <p className="hint">
                Form fields:{" "}
                {preview.fields.length === 0
                  ? "none"
                  : preview.fields
                      .map((field) => `${field.label}${field.required ? " (required)" : ""}`)
                      .join(" · ")}
                . Use {"{{key}}"} to add a field; {"{{cwd}}"}, {"{{folderName}}"}, {"{{date}}"}{" "}
                and {"{{roleName}}"} fill themselves.
              </p>
            ) : null}
          </div>
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              disabled={busy || !!preview?.error}
              onClick={() => void save()}
            >
              {busy ? "Working…" : "Save"}
            </button>
            {detail.isBuiltIn && (
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void reset()}>
                Reset built-in
              </button>
            )}
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void duplicate()}>
              Duplicate
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void exportOne()}>
              Export…
            </button>
            {!detail.isBuiltIn && !confirmDelete && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
          {confirmDelete && !detail.isBuiltIn && (
            <div className="role-delete-confirm" role="alertdialog" aria-label="Delete role">
              <p>
                Delete {detail.name}? This cannot be undone. Export it first to keep a copy.
              </p>
              <div className="button-row">
                <button type="button" className="primary-button" disabled={busy} onClick={() => void remove()}>
                  Delete role
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep it
                </button>
              </div>
            </div>
          )}
          {notice && <p className="hint">{notice}</p>}
        </div>
      )}
    </section>
  );
}
