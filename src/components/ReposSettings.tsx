import { useEffect, useState } from "react";
import { getReposSettings, setReposSettings, type RepoEntry } from "../bridge";
import { repoNameProblem } from "../pipeline/repos";
import { FolderPicker } from "./FolderPicker";
import { errorText, InlineNotice } from "./InlineNotice";
import { useConfirm } from "./confirm";

/** The form open now: a new repo (`index` null) or an edit of one. */
type Draft = { index: number | null; name: string; folder: string; touched: boolean };

/**
 * Settings › Repos (Eagle-Eye v3, L1): named git repos a plan can span. A
 * Planner task names one (`"repo": "engine"`) and fan-out makes that lane's
 * worktree in its folder. Each add, edit or removal saves the whole list;
 * Rust checks it again (names, and that each folder is a git repo) and its
 * answer shows under the form.
 */
export function ReposSettings() {
  const [repos, setRepos] = useState<RepoEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    let cancelled = false;
    getReposSettings()
      .then((list) => {
        if (!cancelled) setRepos(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!repos) {
    return (
      <section className="settings-section" aria-label="Repos">
        <h3>Repos</h3>
        {loadError ? <InlineNotice tone="error">{loadError}</InlineNotice> : <p className="hint">Loading…</p>}
      </section>
    );
  }

  const others = draft ? repos.filter((_, i) => i !== draft.index).map((repo) => repo.name) : [];
  const nameProblem = draft?.touched ? repoNameProblem(draft.name, others) : null;
  const folderMissing = draft?.touched && !draft.folder.trim() ? "Choose the repo's folder." : null;

  const save = async (next: RepoEntry[]): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    try {
      setRepos(await setReposSettings(next));
      return true;
    } catch (err: unknown) {
      setSaveError(errorText(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (!draft) return;
    const touched = { ...draft, touched: true };
    setDraft(touched);
    if (repoNameProblem(draft.name, others) || !draft.folder.trim()) return;
    const entry = { name: draft.name.trim(), folder: draft.folder.trim() };
    const next = draft.index === null ? [...repos, entry] : repos.map((repo, i) => (i === draft.index ? entry : repo));
    if (await save(next)) setDraft(null);
  };

  const remove = async (index: number) => {
    const repo = repos[index];
    const ok = await confirm({
      title: "Remove repo",
      message: `Remove “${repo.name}” from DCTerminal? Its folder (${repo.folder}) is not touched. A run whose plan names ${repo.name} stops before it starts a lane there.`,
      confirmLabel: "Remove repo",
      danger: true,
    });
    if (ok) await save(repos.filter((_, i) => i !== index));
  };

  return (
    <section className="settings-section" aria-label="Repos">
      <h3>Repos</h3>
      <p className="hint">
        Name the git repos a plan can span, such as backend and engine. The Planner sees this list, and
        each task that names a repo gets its own worktree in that repo&apos;s folder. A task that names
        none is built in the run&apos;s own folder.
      </p>
      {repos.length === 0 ? (
        <p className="hint">No repos yet.</p>
      ) : (
        <ul className="repos-list" aria-label="Your repos">
          {repos.map((repo, index) => (
            <li key={repo.name}>
              <strong>{repo.name}</strong> <code>{repo.folder}</code>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  aria-label={`Edit ${repo.name}`}
                  onClick={() => {
                    setSaveError(null);
                    setDraft({ index, name: repo.name, folder: repo.folder, touched: false });
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  aria-label={`Remove ${repo.name}`}
                  onClick={() => void remove(index)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <div className="settings-subsection" aria-label={draft.index === null ? "New repo" : `Editing ${repos[draft.index]?.name}`}>
          <label className="field-label">
            Name
            <input
              type="text"
              value={draft.name}
              placeholder="backend"
              aria-invalid={nameProblem ? true : undefined}
              onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value, touched: true })}
            />
          </label>
          {nameProblem && <p className="error">{nameProblem}</p>}
          <div className="field-label">
            Folder
            <FolderPicker
              value={draft.folder}
              disabled={saving}
              onChange={(folder) => setDraft({ ...draft, folder, touched: true })}
            />
          </div>
          {folderMissing && <p className="error">{folderMissing}</p>}
          {saveError && <p className="error" role="alert">{saveError}</p>}
          <div className="button-row">
            <button type="button" className="primary-button" disabled={saving} onClick={() => void submit()}>
              {saving ? "Saving…" : "Save repo"}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setSaveError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {saveError && <p className="error" role="alert">{saveError}</p>}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSaveError(null);
              setDraft({ index: null, name: "", folder: "", touched: false });
            }}
          >
            Add repo
          </button>
        </>
      )}
    </section>
  );
}
