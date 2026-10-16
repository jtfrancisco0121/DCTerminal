import type { HeaderState } from "../terminal/headerState";

/** The last `count` segments of a folder path ("Projects/app"); null when empty. */
export function folderTail(cwd: string | null | undefined, count = 2): string | null {
  const parts = (cwd ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts.slice(-count).join("/") : null;
}

type Props = {
  /** 1-based pane number: the main pane is 1, the second pane 2, grid cells in order. */
  number: number;
  roleName: string;
  cwd: string | null | undefined;
  branch?: string | null;
  /** The tab's state pill (headerStateOf), as its terminal header shows it. */
  state: HeaderState;
  focused: boolean;
};

/**
 * The thin strip on top of each pane of a split or grid: which pane, whose
 * role, where it works, and how it is doing. The focused pane's strip
 * carries the accent line.
 */
export function PaneStrip({ number, roleName, cwd, branch, state, focused }: Props) {
  const folder = folderTail(cwd);
  const where = [folder, branch].filter(Boolean).join(" on ");
  return (
    <div
      className={focused ? "pane-strip pane-strip-focused" : "pane-strip"}
      data-testid="pane-strip"
      aria-label={`Pane ${number}: ${roleName}${where ? `, ${where}` : ""}, ${state.text}${focused ? ", focused" : ""}`}
      role="group"
    >
      <span className="pane-strip-number" aria-hidden="true">
        {number}
      </span>
      <span className="pane-strip-role">{roleName}</span>
      {folder && (
        <span className="pane-strip-meta" title={cwd ?? undefined}>
          {folder}
        </span>
      )}
      {branch && (
        <span className="pane-strip-meta pane-strip-branch" title={`Branch ${branch}`}>
          {branch}
        </span>
      )}
      <span className="pane-strip-spacer" />
      <span className={`pane-strip-pill pane-strip-pill-${state.tone}`}>{state.text}</span>
    </div>
  );
}
