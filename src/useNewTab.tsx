/**
 * ⌘/Ctrl+T and a launch with no saved tabs follow the "New tab opens"
 * setting: ask (the picker), Claude or a shell in the resolved folder, or the
 * start screen. The picker's Role… row opens the role launcher. StartupForm
 * supplies the actions; this hook decides.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import type { NewTabOpens } from "./bridge";
import { NewTabPicker } from "./components/NewTabPicker";
import { loadNewTabContext, newTabMode, type NewTabContext } from "./newTab";
import type { NewTerminalLaunch } from "./terminal/openTerminalTab";

type Options = {
  /** The saved setting (any string; unknown reads as `ask`). */
  mode: () => string | null | undefined;
  /** The active tab's folder, for "here". */
  activeCwd: () => string | null;
  /** The start screen in a new tab (today's ⌘T). */
  openStartScreen: () => Promise<unknown>;
  /**
   * The role launcher (the picker's Role…); `reuseTabId` is an untouched
   * draft the picked role fills instead of a new tab.
   */
  openRoleLauncher: (reuseTabId: string | null) => void;
  /** The window's GitHub tab (the picker's GitHub row). */
  openGithub: () => void;
  /** Open a terminal tab; `reuseTabId` is an untouched draft to turn into it. */
  openTerminal: (launch: NewTerminalLaunch, cwd: string, reuseTabId: string | null) => Promise<void>;
  /** Save a new value for the setting ("Don't ask again"). */
  saveMode: (mode: NewTabOpens) => void;
};

type PickerState = { context: NewTabContext | null; reuseTabId: string | null };

export function useNewTab(options: Options): {
  /** ⌘/Ctrl+T. */
  request: () => Promise<void>;
  /** First launch with no saved tabs: `draftTabId` is the start-screen tab already shown. */
  launch: (draftTabId: string, mode: string | null | undefined) => Promise<void>;
  picker: ReactNode;
} {
  const latest = useRef(options);
  latest.current = options;
  const [picker, setPicker] = useState<PickerState | null>(null);
  // A request that was superseded (Esc, or another ⌘T) must not fill a later picker.
  const tokenRef = useRef(0);

  const openPicker = useCallback(async (reuseTabId: string | null) => {
    const token = ++tokenRef.current;
    setPicker({ context: null, reuseTabId });
    const context = await loadNewTabContext(latest.current.activeCwd());
    if (token !== tokenRef.current) return;
    setPicker((current) => (current ? { ...current, context } : current));
  }, []);

  const run = useCallback(
    async (mode: NewTabOpens, reuseTabId: string | null) => {
      const actions = latest.current;
      if (mode === "ask") return openPicker(reuseTabId);
      if (mode === "start") {
        // A launch already shows the start screen in its draft tab.
        if (!reuseTabId) await actions.openStartScreen();
        return;
      }
      const { folder } = await loadNewTabContext(actions.activeCwd());
      const launch: NewTerminalLaunch = mode === "shell" ? "shell" : "claude-cli";
      if (folder) await actions.openTerminal(launch, folder, reuseTabId);
      else if (!reuseTabId) await actions.openStartScreen();
    },
    [openPicker],
  );

  const request = useCallback(() => run(newTabMode(latest.current.mode()), null), [run]);
  const launch = useCallback(
    (draftTabId: string, mode: string | null | undefined) => run(newTabMode(mode), draftTabId),
    [run],
  );

  const close = () => {
    tokenRef.current += 1;
    setPicker(null);
  };
  const reuse = picker?.reuseTabId ?? null;
  const node = picker ? (
    <NewTabPicker
      context={picker.context}
      onClose={close}
      onClaude={(cwd) => {
        close();
        void latest.current.openTerminal("claude-cli", cwd, reuse);
      }}
      onShell={(cwd) => {
        close();
        void latest.current.openTerminal("shell", cwd, reuse);
      }}
      onRole={() => {
        close();
        latest.current.openRoleLauncher(reuse);
      }}
      onGithub={() => {
        close();
        latest.current.openGithub();
      }}
      onDontAskAgain={() => latest.current.saveMode("claude")}
    />
  ) : null;

  return { request, launch, picker: node };
}
