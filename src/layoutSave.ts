/**
 * The split and file panel layout, saved to state.json shortly after each
 * change so it survives a restart (StartupForm debounces the calls).
 */
import { setLayout, type LayoutState } from "./bridge";
import { clampSplitSize, gridOpen, splitOpen, type SplitState } from "./tabChrome";
import { reportError } from "./uiErrors";

export function layoutToSave(split: SplitState, filePanelOpen: boolean, filePanelWidth: number): LayoutState {
  const open = splitOpen(split);
  const grid = gridOpen(split);
  return {
    splitMode: open ? split.mode : "single",
    secondaryTabId: open && !grid ? split.secondaryTabId : null,
    gridTabIds: grid ? (split.gridTabIds ?? []) : [],
    primarySize: clampSplitSize(split.primarySize),
    filePanelOpen,
    filePanelWidth,
  };
}

/** A background save: a failure is shown once per window, not on every change. */
export async function saveLayout(
  split: SplitState,
  filePanelOpen: boolean,
  filePanelWidth: number,
  save: (layout: LayoutState) => Promise<unknown> = setLayout,
): Promise<void> {
  try {
    await save(layoutToSave(split, filePanelOpen, filePanelWidth));
  } catch (err) {
    reportError("Layout not saved", err, { notify: true, once: true });
  }
}
