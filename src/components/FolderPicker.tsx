import { useCallback, useEffect, useState } from "react";
import {
  pickFolder,
  projectsList,
  projectsRemove,
  projectsToggleFavorite,
  type ListedProject,
} from "../bridge";
import { folderPickFillsField, normalizeFolderPath, projectRowLabel } from "../projectsView";

type Props = {
  value: string;
  disabled?: boolean;
  onChange: (path: string) => void;
};

export function FolderPicker({ value, disabled, onChange }: Props) {
  const [favorites, setFavorites] = useState<ListedProject[]>([]);
  const [recent, setRecent] = useState<ListedProject[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const lists = await projectsList();
      setFavorites(lists.favorites);
      setRecent(lists.recent);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = (path: string) => {
    const picked = folderPickFillsField(path);
    onChange(picked.cwd);
    setOpen(false);
  };

  const browse = async () => {
    setError(null);
    try {
      const path = await pickFolder();
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

  const starred = favorites.some(
    (item) => normalizeFolderPath(item.path) === normalizeFolderPath(value),
  );

  return (
    <div className="folder-picker">
      <div className="folder-picker-row">
        <input
          className="text-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-label="Working folder path"
        />
        <button type="button" className="secondary-button" onClick={browse} disabled={disabled}>
          Browse…
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void star()}
          disabled={disabled || !value.trim()}
          title={starred ? "Remove favorite" : "Star as favorite"}
        >
          {starred ? "★" : "☆"}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setOpen((current) => !current)}
          disabled={disabled}
        >
          Recent
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {open && (
        <div className="folder-picker-menu" role="listbox" aria-label="Recent and favorite folders">
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
            <p className="hint">No saved folders yet. Browse or start a session to add one.</p>
          )}
        </div>
      )}
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
