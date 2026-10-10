import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  checkWorkingFolder,
  projectsList,
  projectsRemove,
  projectsToggleFavorite,
  type ListedProject,
} from "../bridge";
import {
  CHOOSE_FOLDER_PROMPT,
  folderName,
  folderPickFillsField,
  nativeDialogPath,
  normalizeFolderPath,
  pastedFolderPath,
  projectRowLabel,
} from "../projectsView";

type Props = {
  value: string;
  disabled?: boolean;
  unavailable?: boolean;
  onChange: (path: string) => void;
  /** U5: one-row picker (folder button, star, Recent menu) for the start row. */
  compact?: boolean;
};

export function FolderPicker({ value, disabled, unavailable, onChange, compact = false }: Props) {
  const [favorites, setFavorites] = useState<ListedProject[]>([]);
  const [recent, setRecent] = useState<ListedProject[]>([]);
  const [openMenu, setOpenMenu] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const lists = await projectsList();
      setFavorites(lists.favorites);
      setRecent(lists.recent);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Folders opened by other tabs (chat or terminal) appear without a remount.
  useEffect(() => {
    if (openMenu) void refresh();
  }, [openMenu, refresh]);

  const choose = (path: string) => {
    const picked = folderPickFillsField(path);
    onChange(picked.cwd);
    setOpenMenu(false);
    setPasted("");
    setError(null);
  };

  const browse = async () => {
    setError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose a working folder",
        defaultPath: value.trim() || undefined,
      });
      const path = nativeDialogPath(selected);
      if (path) choose(path);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const star = async () => {
    if (!value.trim()) return;
    try {
      await projectsToggleFavorite(value.trim());
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (path: string, favorite: boolean) => {
    try {
      await projectsRemove(path, favorite);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const usePastedPath = async () => {
    const path = pastedFolderPath(pasted);
    if (!path) {
      setError("Enter a folder path.");
      return;
    }
    try {
      const checked = await checkWorkingFolder(path);
      choose(checked);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const starred = favorites.some(
    (item) => normalizeFolderPath(item.path) === normalizeFolderPath(value),
  );
  const trimmed = value.trim();
  const name = folderName(trimmed);

  const menu = openMenu ? (
        <div className="folder-picker-menu" role="menu" aria-label="Saved folders">
          <ProjectSection
            title="Favorites"
            items={favorites}
            onPick={choose}
            onRemove={(path) => void remove(path, true)}
          />
          <ProjectSection
            title="Recent"
            items={recent}
            onPick={choose}
            onRemove={(path) => void remove(path, false)}
          />
          {favorites.length === 0 && recent.length === 0 && (
            <p className="hint">No saved folders yet.</p>
          )}
          <form
            className="folder-picker-paste"
            onSubmit={(event) => {
              event.preventDefault();
              void usePastedPath();
            }}
          >
            <label className="field-label">
              Enter path
              <input
                className="text-input"
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                disabled={disabled}
                spellCheck={false}
                aria-label="Enter a folder path"
              />
            </label>
            <button type="submit" className="secondary-button" disabled={disabled}>
              Use path
            </button>
          </form>
        </div>
  ) : null;

  if (compact) {
    return (
      <div className="folder-picker folder-picker-compact">
        <div className="folder-picker-row">
          <button
            type="button"
            className={`secondary-button folder-picker-chosen${unavailable ? " folder-picker-unavailable" : ""}`}
            title={trimmed || undefined}
            aria-label={trimmed ? `Working folder ${trimmed}. Choose folder…` : "Choose folder…"}
            onClick={() => void browse()}
            disabled={disabled}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                fill="currentColor"
                d="M1.75 2.5h4l1.5 1.5h7a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75H1.75a.75.75 0 0 1-.75-.75v-10a.75.75 0 0 1 .75-.75z"
              />
            </svg>
            <span className="folder-picker-name">{trimmed ? name : "Choose folder…"}</span>
            {unavailable && <span className="error">unavailable</span>}
          </button>
          <button
            type="button"
            className="secondary-button folder-picker-icon"
            onClick={() => void star()}
            disabled={disabled || !trimmed}
            title={starred ? "Remove favorite" : "Star as favorite"}
            aria-label={starred ? "Remove favorite" : "Star as favorite"}
            aria-pressed={starred}
          >
            {starred ? "★" : "☆"}
          </button>
          <button
            type="button"
            className="secondary-button folder-picker-icon"
            onClick={() => setOpenMenu((current) => !current)}
            disabled={disabled}
            aria-expanded={openMenu}
            aria-haspopup="menu"
            aria-label="Recent"
            title="Recent and favorite folders, or type a path"
          >
            ▾
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {menu}
      </div>
    );
  }

  return (
    <div className="folder-picker">
      <div className="folder-picker-row">
        <button
          type="button"
          className="primary-button"
          onClick={() => void browse()}
          disabled={disabled}
        >
          Choose folder…
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void star()}
          disabled={disabled || !trimmed}
          title={starred ? "Remove favorite" : "Star as favorite"}
          aria-pressed={starred}
        >
          {starred ? "★" : "☆"}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setOpenMenu((current) => !current)}
          disabled={disabled}
          aria-expanded={openMenu}
          aria-haspopup="menu"
        >
          Recent
        </button>
      </div>
      {trimmed ? (
        <div className="folder-picker-chosen" title={trimmed}>
          <div className="folder-picker-name-row">
            <span className="folder-picker-name">{name}</span>
            {unavailable && <span className="error">unavailable</span>}
          </div>
          <span className="hint folder-picker-full">{trimmed}</span>
        </div>
      ) : (
        <p className="folder-picker-prompt">{CHOOSE_FOLDER_PROMPT}</p>
      )}
      {error && <p className="error">{error}</p>}
      {menu}
    </div>
  );
}

function ProjectSection({
  title,
  items,
  onPick,
  onRemove,
}: {
  title: string;
  items: ListedProject[];
  onPick: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="folder-picker-heading">{title}</p>
      <ul className="folder-picker-list">
        {items.map((item) => (
          <li key={`${title}-${item.path}`}>
            <button
              type="button"
              className="folder-picker-path"
              role="menuitem"
              onClick={() => onPick(item.path)}
            >
              {projectRowLabel(item.path, item.available)}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onRemove(item.path)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
