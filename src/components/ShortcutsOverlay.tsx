import { shortcutRows, type Platform } from "../keymap";

type Props = {
  platform: Platform;
  onClose: () => void;
};

export function ShortcutsOverlay({ platform, onClose }: Props) {
  const rows = shortcutRows(platform);
  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel"
        role="dialog"
        aria-labelledby="shortcuts-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="overlay-header">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" className="secondary-button" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="hint">
          Plain Ctrl in the chat and scratch pad (⌘ on macOS). Ctrl+Shift is for the terminal:
          copy, paste, search, the shell pane, and transfer. Ctrl+C still goes to the shell.
          Copy, paste, undo, and IME composition in text fields are left alone.
        </p>
        <ul className="shortcut-list">
          {rows.map((row) => (
            <li key={`${row.action}-${row.label}-${row.keys}`}>
              <kbd>{row.keys}</kbd>
              <span>
                <strong>{row.label}</strong>
                <span className="hint"> — {row.description}</span>
              </span>
            </li>
          ))}
          <li>
            <kbd>Esc</kbd>
            <span>
              <strong>Cancel turn</strong>
              <span className="hint"> — while a turn is running and no dialog is open</span>
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
