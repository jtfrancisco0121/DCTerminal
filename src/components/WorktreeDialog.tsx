import { useEffect, useState } from "react";
import type { RepoInfo, RoleSummary } from "../bridge";
import {
  worktreeDestination,
  worktreeFormError,
  type WorktreeMode,
} from "../worktree/worktreeForm";
import { FolderPicker } from "./FolderPicker";

export type WorktreeCreateInput = {
  repoPath: string;
  branch: string;
  createBranch: boolean;
  base: string | null;
  roleId: string;
};

type Props = {
  initialRepo: string;
  roles: RoleSummary[];
  defaultRoleId: string;
  loadRepo: (path: string) => Promise<RepoInfo>;
  /** Runs `git worktree add` and opens the tab. Throws with git's message. */
  onCreate: (input: WorktreeCreateInput) => Promise<void>;
  onClose: () => void;
};

/** F3 "New tab in worktree…". Nothing touches git until Create is clicked. */
export function WorktreeDialog({
  initialRepo,
  roles,
  defaultRoleId,
  loadRepo,
  onCreate,
  onClose,
}: Props) {
  const [repo, setRepo] = useState(initialRepo);
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [mode, setMode] = useState<WorktreeMode>("new");
  const [newBranch, setNewBranch] = useState("");
  const [existing, setExisting] = useState("");
  const [base, setBase] = useState("");
  const [roleId, setRoleId] = useState(defaultRoleId);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const path = repo.trim();
    setInfo(null);
    setRepoError(null);
    if (!path) return;
    let cancelled = false;
    loadRepo(path)
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        setBase(next.currentBranch ?? next.branches[0] ?? "");
        setExisting("");
      })
      .catch((err: unknown) => {
        if (!cancelled) setRepoError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [repo, loadRepo]);

  const branch = mode === "new" ? newBranch.trim() : existing;
  const formError = info ? worktreeFormError({ mode, branch }, info) : null;
  const free = info ? info.branches.filter((b) => !info.checkedOut.includes(b)) : [];
  const canCreate = !!info && !formError && !busy && roles.some((r) => r.id === roleId);

  const create = async () => {
    if (!info || !canCreate) return;
    setBusy(true);
    setCreateError(null);
    try {
      await onCreate({
        repoPath: repo.trim(),
        branch,
        createBranch: mode === "new",
        base: mode === "new" ? base || null : null,
        roleId,
      });
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel worktree-dialog"
        role="dialog"
        aria-label="New tab in worktree"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h3>New tab in worktree</h3>
        <p className="hint">
          Runs <code>git worktree add</code> into a folder next to the repository. The
          repository&apos;s own checkout is not changed.
        </p>
        <div className="field-label">
          Repository
          <FolderPicker value={repo} disabled={busy} onChange={setRepo} />
        </div>
        {repoError && <p className="error">{repoError}</p>}
        {info && (
          <>
            <div className="role-choices" role="radiogroup" aria-label="Branch source">
              <label className="worktree-mode">
                <input
                  type="radio"
                  name="worktree-mode"
                  checked={mode === "new"}
                  onChange={() => setMode("new")}
                />
                New branch
              </label>
              <label className="worktree-mode">
                <input
                  type="radio"
                  name="worktree-mode"
                  checked={mode === "existing"}
                  onChange={() => setMode("existing")}
                  disabled={free.length === 0}
                />
                Existing branch
              </label>
            </div>
            {mode === "new" ? (
              <>
                <label className="field-label">
                  New branch name
                  <input
                    className="text-input"
                    autoFocus
                    value={newBranch}
                    placeholder="feat/my-change"
                    onChange={(event) => setNewBranch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void create();
                      }
                    }}
                  />
                </label>
                <label className="field-label">
                  Start from
                  <select
                    className="text-input"
                    value={base}
                    onChange={(event) => setBase(event.target.value)}
                  >
                    {info.branches.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <label className="field-label">
                Branch
                <select
                  className="text-input"
                  value={existing}
                  onChange={(event) => setExisting(event.target.value)}
                >
                  <option value="">Choose a branch</option>
                  {free.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field-label">
              Role for the new tab
              <select
                className="text-input"
                value={roleId}
                onChange={(event) => setRoleId(event.target.value)}
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            {branch && (
              <p className="hint">
                Folder: <code>{worktreeDestination(info.worktreesDir, branch)}</code>
              </p>
            )}
            {branch && formError && <p className="error">{formError}</p>}
          </>
        )}
        {createError && <p className="error">{createError}</p>}
        <div className="button-row">
          <button
            type="button"
            className="primary-button"
            onClick={() => void create()}
            disabled={!canCreate}
          >
            {busy ? "Creating…" : "Create worktree and open tab"}
          </button>
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
