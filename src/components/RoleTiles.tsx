import type { RoleSummary } from "../bridge";

type LaunchChoice = "shell" | "cursor-cli" | "claude-cli" | null;

type Props = {
  roles: RoleSummary[];
  pickedRoleId: string | null;
  launchChoice: LaunchChoice;
  busy: boolean;
  onChooseRole: (id: string) => void;
  onLaunchShell: () => void;
  onLaunchCursorCli: () => void;
  /** Plain `claude` with the configured `CLAUDE_CONFIG_DIR` (your `claude2`). */
  onLaunchClaudeCli?: () => void;
};

/** Role and launch targets for the blank-tab start card (grid tiles, not a top navbar). */
export function RoleTiles({
  roles,
  pickedRoleId,
  launchChoice,
  busy,
  onChooseRole,
  onLaunchShell,
  onLaunchCursorCli,
  onLaunchClaudeCli,
}: Props) {
  return (
    <div className="role-tile-grid" role="group" aria-label="Role">
      {roles.map((item) => (
        <button
          key={item.id}
          type="button"
          className="role-tile"
          aria-pressed={pickedRoleId === item.id && !launchChoice}
          onClick={() => onChooseRole(item.id)}
          disabled={busy}
        >
          <span className="role-dot" style={{ background: item.color }} aria-hidden />
          {item.name}
        </button>
      ))}
      <button
        type="button"
        className="role-tile"
        aria-pressed={launchChoice === "shell"}
        onClick={onLaunchShell}
        disabled={busy}
      >
        Terminal
      </button>
      {onLaunchClaudeCli && (
        <button
          type="button"
          className="role-tile"
          aria-pressed={launchChoice === "claude-cli"}
          onClick={onLaunchClaudeCli}
          disabled={busy}
        >
          Claude Code
        </button>
      )}
      <button
        type="button"
        className="role-tile"
        aria-pressed={launchChoice === "cursor-cli"}
        onClick={onLaunchCursorCli}
        disabled={busy}
      >
        Cursor CLI
      </button>
    </div>
  );
}
