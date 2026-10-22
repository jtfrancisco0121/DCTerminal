import { useEffect, useState } from "react";
import { getReposSettings, setReposSettings, type RepoEntry } from "../bridge";
import { repoCheckProblem, repoEntry, repoNameProblem, repoVerifyProblem } from "../pipeline/repos";
import { FolderPicker } from "./FolderPicker";
import { errorText, InlineNotice } from "./InlineNotice";
import { useConfirm } from "./confirm";

/** The form open now: a new repo (`index` null) or an edit of one. */
type Draft = {
  index: number | null;
  name: string;
  folder: string;
  /** L2: the repo's check command and verify steps; blank is none. */
  check: string;
  verify: string;
  touched: boolean;
};

/**
 * Settings › Repos (Eagle-Eye v3, L1): named git repos a plan can span. A
 * Planner task names one (`"repo": "engine"`) and fan-out makes that lane's
 * worktree in its folder. Each add, edit or removal saves the whole list;
 * Rust checks it again (names, and that each folder is a git repo) and its
 * answer shows under the form. L2 adds an optional check command per repo
 * (it replaces the stage's command gates in that repo's lanes) and verify
 * steps you carry out yourself after the check passes.
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
  const checkProblem = draft ? repoCheckProblem(draft.check) : null;
  const verifyProblem = draft ? repoVerifyProblem(draft.verify) : null;

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
    if (repoNameProblem(draft.name, others) || !draft.folder.trim() || checkProblem || verifyProblem) return;
    const entry = repoEntry(draft.name, draft.folder, draft.check, draft.verify);
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
        none is built in the run&apos;s own folder. A repo&apos;s check, if you set one, replaces the
        pipeline&apos;s check command in that repo&apos;s lanes; its verify steps make the run wait for
        you to mark them verified once the check passes.
      </p>
      {repos.length === 0 ? (
        <p className="hint">No repos yet.</p>
      ) : (
        <ul className="repos-list" aria-label="Your repos">
          {repos.map((repo, index) => (
            <li key={repo.name}>
              <strong>{repo.name}</strong> <code>{repo.folder}</code>
              {(repo.check || repo.verify) && (
                <p className="hint repos-gates">
                  {repo.check && (
                    <>
                      Check: <code>{repo.check}</code>
                    </>
                  )}
                  {repo.check && repo.verify && <br />}
                  {repo.verify && <>Verify: {repo.verify}</>}
                </p>
              )}
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  aria-label={`Edit ${repo.name}`}
                  onClick={() => {
                    setSaveError(null);
                    setDraft({
                      index,
                      name: repo.name,
                      folder: repo.folder,
                      check: repo.check ?? "",
                      verify: repo.verify ?? "",
                      touched: false,
                    });
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
          <label className="field-label">
            Check (optional)
            <input
              type="text"
              value={draft.check}
              placeholder="cd server && go test ./..."
              aria-invalid={checkProblem ? true : undefined}
              onChange={(event) => setDraft({ ...draft, check: event.currentTarget.value })}
            />
          </label>
          <p className="hint">
            One command, run in each lane&apos;s worktree in this repo instead of the pipeline&apos;s check.
          </p>
          {checkProblem && <p className="error">{checkProblem}</p>}
          <label className="field-label">
            Verify steps (optional)
            <textarea
              value={draft.verify}
              rows={3}
              placeholder="Run the qa128-ml Playwright project on the Windows staging build."
              aria-invalid={verifyProblem ? true : undefined}
              onChange={(event) => setDraft({ ...draft, verify: event.currentTarget.value })}
            />
          </label>
          <p className="hint">
            Checks the app cannot run itself. After the check passes, the run waits for you to mark them
            verified, or failed with a note that goes back to the lane.
          </p>
          {verifyProblem && <p className="error">{verifyProblem}</p>}
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
              setDraft({ index: null, name: "", folder: "", check: "", verify: "", touched: false });
            }}
          >
            Add repo
          </button>
        </>
      )}
    </section>
  );
}
