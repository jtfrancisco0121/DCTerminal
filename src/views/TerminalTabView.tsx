import type { ReactNode, RefObject } from "react";
import {
  promptRecordSend,
  ptyWrite,
  type HandoffRecord,
  type RoleSummary,
  type TabSummary,
} from "../bridge";
import { snapshotTerminalTurn } from "../changes/turnSnapshot";
import { HandoffBanner } from "../components/HandoffDialog";
import { TerminalScratchPad, type TerminalPadHandle } from "../components/TerminalScratchPad";
import { TerminalView } from "../components/TerminalView";
import { handoffMenuItems, type HandoffTargetId } from "../handoff/map";
import type { HandoffRoute } from "../handoff/routing";
import type { Platform } from "../keymap";
import { livePty } from "../terminal/live";
import { blurParkedTerminal, refitTerminal, terminalBracketedPaste } from "../terminal/park";
import type { useScratchPads } from "../useScratchPads";
import type { useUiSettings } from "../useUiSettings";
import { terminalLaunchOf, type PadSizeProps } from "./tabHelpers";

export type TerminalTabViewProps = {
  activeTabId: string | null;
  /** The active tab: a terminal tab. */
  activeTabSummary: TabSummary;
  handoffs: HandoffRecord[];
  roles: RoleSummary[];
  /** Tabs whose hand-off prompt was saved to a file. */
  promptFileTabs: string[];
  terminalError: string | null;
  /** A role terminal that can hand off. */
  isPlanTerminal: boolean;
  terminalRoute: HandoffRoute | null;
  fontSize: number;
  /** The terminal header (R16); null in a grid cell, whose own bar shows it. */
  header: ReactNode;
  /** Grid view: the cell bar is the header and the scratch pad is hidden. */
  inGrid: boolean;
  scratch: ReturnType<typeof useScratchPads>;
  platform: Platform;
  padOpen: boolean;
  uiSettings: ReturnType<typeof useUiSettings>;
  padSizeProps: PadSizeProps;
  terminalPadRef: RefObject<TerminalPadHandle | null>;
  openSavedHandoff: (record: HandoffRecord, showText?: boolean) => void;
  readTerminalVerdict: (tabId: string | null | undefined, fresh?: boolean) => void;
  openTerminalHandoff: (target: HandoffTargetId, sourceTabId?: string) => Promise<void>;
  notePadSelection: () => void;
  openPromptLibrary: (save: boolean) => void;
  focusActiveTerminal: () => void;
};

/** The active terminal tab: hand-off banner, toolbar, terminal and scratch pad. */
export function TerminalTabView({
  activeTabId,
  activeTabSummary,
  handoffs,
  roles,
  promptFileTabs,
  terminalError,
  isPlanTerminal,
  terminalRoute,
  fontSize,
  header,
  inGrid,
  scratch,
  platform,
  padOpen,
  uiSettings,
  padSizeProps,
  terminalPadRef,
  openSavedHandoff,
  readTerminalVerdict,
  openTerminalHandoff,
  notePadSelection,
  openPromptLibrary,
  focusActiveTerminal,
}: TerminalTabViewProps) {
  const linked = handoffs.find((item) => item.targetTabId === activeTabId) ?? null;
  const launch = terminalLaunchOf(activeTabSummary);
  return (
    <section className="status-card status-card-session-full terminal-screen">
      {linked && (
        <HandoffBanner
          sourceRoleId={linked.sourceRoleId}
          title={linked.title}
          warning={linked.warning}
          roleNames={roles}
          onOpen={() => openSavedHandoff(linked)}
          fileNote={
            promptFileTabs.includes(linked.targetTabId ?? "")
              ? "The prompt was too long to pass directly, so Claude Code reads it from a file."
              : null
          }
          onOpenText={() => openSavedHandoff(linked, true)}
        />
      )}
      {terminalError && <p className="error">{terminalError}</p>}
      {!inGrid && header}
      <TerminalView
        ptyId={activeTabSummary.id}
        cwd={activeTabSummary.cwd}
        launch={launch}
        roleId={activeTabSummary.roleId}
        fontSize={fontSize}
        resumeSessionId={activeTabSummary.resumeSessionId}
        autoOpen={!livePty(activeTabSummary.id)}
        onMenuOpen={() => readTerminalVerdict(activeTabSummary.id, true)}
        menuActions={
          isPlanTerminal
            ? handoffMenuItems(activeTabSummary.roleId, roles).map((item) => ({
                id: `send-${item.target}`,
                label:
                  item.target === terminalRoute?.primaryTarget && terminalRoute.primaryLabel
                    ? terminalRoute.primaryLabel
                    : item.label,
                onSelect: () => {
                  void openTerminalHandoff(item.target);
                },
              }))
            : []
        }
      />
      {!inGrid && (
        <TerminalScratchPad
          ref={terminalPadRef}
          tabId={activeTabSummary.id}
          ptyId={activeTabSummary.id}
          content={scratch.content}
          truncated={scratch.truncated}
          persistError={scratch.persistError}
          platform={platform}
          onChange={(value) => scratch.setContent(activeTabSummary.id, value)}
          onBlur={() => {
            notePadSelection();
            scratch.flush();
          }}
          onSent={(text) => void promptRecordSend(text, "terminal").catch(() => {})}
          beforeSubmit={snapshotTerminalTurn}
          onOpenLibrary={() => openPromptLibrary(false)}
          write={ptyWrite}
          bracketedPaste={() => terminalBracketedPaste(activeTabSummary.id)}
          onFocusTerminal={focusActiveTerminal}
          onFocusPad={() => blurParkedTerminal(activeTabSummary.id)}
          onOpenChange={() => refitTerminal(activeTabSummary.id)}
          open={padOpen}
          onOpenToggle={(open) => uiSettings.update({ padHidden: !open })}
          {...padSizeProps}
        />
      )}
    </section>
  );
}
