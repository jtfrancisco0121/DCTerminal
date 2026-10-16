/**
 * ⌘/Ctrl+T: where the new tab opens. Keyboard-first: one letter per row,
 * 1–9 for recent projects, ↑↓ and Enter for the highlighted row.
 *
 * Design after ADE (better-agentic-ide) src/components/NewTabDialog.tsx,
 * MIT License, (c) 2025-2026 Alvin Reyes.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useId, useState, type KeyboardEvent } from "react";
import { folderName, pickerKeyAction, tildePath, type NewTabContext } from "../newTab";
import { nativeDialogPath } from "../projectsView";
import { Dialog } from "./Dialog";
import { errorText } from "./InlineNotice";

type Row =
  | { id: "claude"; key: "C" }
  | { id: "shell"; key: "S" }
  | { id: "role"; key: "R" }
  | { id: "recent"; key: string; path: string; index: number }
  | { id: "open"; key: "O" };

type Props = {
  /** Null while the folder and recent projects load. */
  context: NewTabContext | null;
  onClaude: (cwd: string) => void;
  onShell: (cwd: string) => void;
  /** The start screen in a new tab (pick a role). */
  onRole: () => void;
  /** The "Don't ask again" box: true sets the setting to `claude`. */
  onDontAskAgain: (checked: boolean) => void;
  onClose: () => void;
  /** Directory picker; the native dialog by default. Null when cancelled. */
  chooseFolder?: () => Promise<string | null>;
};

async function nativeChooseFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: "Open a folder in Claude" });
  return nativeDialogPath(picked);
}

export function NewTabPicker({
  context,
  onClaude,
  onShell,
  onRole,
  onDontAskAgain,
  onClose,
  chooseFolder = nativeChooseFolder,
}: Props) {
  const listId = useId();
  const [cursor, setCursor] = useState(0);
  const [dontAsk, setDontAsk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folder = context?.folder ?? null;
  const recents = context?.recents ?? [];
  const home = context?.home ?? null;

  const rows: Row[] = [
    { id: "claude", key: "C" },
    { id: "shell", key: "S" },
    { id: "role", key: "R" },
    ...recents.map((path, index) => ({ id: "recent" as const, key: String(index + 1), path, index })),
    { id: "open", key: "O" },
  ];
  const active = Math.min(cursor, rows.length - 1);
  const rowId = (i: number) => `${listId}-row-${i}`;

  const browse = async () => {
    setError(null);
    try {
      const picked = await chooseFolder();
      if (picked) onClaude(picked);
    } catch (err: unknown) {
      setError(errorText(err));
    }
  };

  const choose = (row: Row) => {
    if (row.id === "claude") {
      if (folder) onClaude(folder);
    } else if (row.id === "shell") {
      if (folder) onShell(folder);
    } else if (row.id === "role") {
      onRole();
    } else if (row.id === "recent") {
      onClaude(row.path);
    } else {
      void browse();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    // Space and Enter on the checkbox or a button keep their own meaning.
    const onControl = event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((active + 1) % rows.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((active - 1 + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      if (onControl) return;
      event.preventDefault();
      choose(rows[active]);
      return;
    }
    const action = pickerKeyAction(event.key, recents.length);
    if (!action) return;
    event.preventDefault();
    if (action.kind === "recent") choose(rows[3 + action.index]);
    else choose(rows.find((row) => row.id === action.kind) ?? rows[0]);
  };

  const here = folder ? tildePath(folder, home) : context ? "No folder yet" : "Finding the folder…";
  const label = (row: Row) => {
    if (row.id === "claude") return { title: "Claude here", detail: here };
    if (row.id === "shell") return { title: "Shell here", detail: here };
    if (row.id === "role") return { title: "Role…", detail: "Pick a role on the start screen" };
    if (row.id === "recent") return { title: folderName(row.path), detail: tildePath(row.path, home) };
    return { title: "Open folder…", detail: "Choose a folder, then open Claude there" };
  };
  const disabled = (row: Row) => (row.id === "claude" || row.id === "shell") && !folder;

  return (
    <Dialog title="New tab" placement="top" className="overlay-panel-new-tab" onClose={onClose}>
      <div className="new-tab-picker" onKeyDown={onKeyDown}>
        <ul
          id={listId}
          className="new-tab-list"
          role="listbox"
          aria-label="Open in the new tab"
          aria-activedescendant={rowId(active)}
          tabIndex={0}
          data-autofocus
        >
          {rows.map((row, i) => {
            const text = label(row);
            return (
              <li key={`${row.id}-${row.key}`} role="presentation">
                {i === 3 && recents.length > 0 && (
                  <div className="new-tab-heading" aria-hidden="true">
                    Recent projects
                  </div>
                )}
                <div
                  id={rowId(i)}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={disabled(row) || undefined}
                  className={i === active ? "new-tab-row new-tab-row-active" : "new-tab-row"}
                  title={row.id === "recent" ? row.path : undefined}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(row)}
                >
                  <span className="new-tab-main">
                    <span className="new-tab-title">{text.title}</span>
                    <span className="new-tab-detail">{text.detail}</span>
                  </span>
                  <kbd aria-hidden="true">{row.id === "claude" ? "C / Enter" : row.key}</kbd>
                </div>
              </li>
            );
          })}
        </ul>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <label className="new-tab-foot">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(event) => {
              setDontAsk(event.target.checked);
              onDontAskAgain(event.target.checked);
            }}
          />
          Don't ask again: always open Claude here
        </label>
        <p className="hint new-tab-hint">Change this in Settings › Terminal. ↑↓ move · Enter opens · Esc closes</p>
      </div>
    </Dialog>
  );
}
