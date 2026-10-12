import type { RefObject } from "react";
import {
  promptRecordSend,
  ptyWrite,
  type HandoffRecord,
  type RoleSummary,
  type TabSummary,
} from "../bridge";
import { snapshotTerminalTurn } from "../changes/turnSnapshot";
import { ChainLabel } from "../components/ChainLabel";
import { HandoffActions, HandoffBanner } from "../components/HandoffDialog";
import { TerminalScratchPad, type TerminalPadHandle } from "../components/TerminalScratchPad";
import { TerminalView } from "../components/TerminalView";
import { chainLabel } from "../handoff/chains";
import { handoffMenuItems, type HandoffTargetId } from "../handoff/map";
import type { HandoffRoute } from "../handoff/routing";
import type { Platform } from "../keymap";
import { livePty } from "../terminal/live";
import { blurParkedTerminal, refitTerminal, terminalBracketedPaste } from "../terminal/park";
import type { useScratchPads } from "../useScratchPads";
import type { useUiSettings } from "../useUiSettings";
import type { HeaderControls } from "./SessionHeaderControls";
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
  planTerminalTargets: HandoffTargetId[];
  terminalRoute: HandoffRoute | null;
  busy: boolean;
  fontSize: number;
  controls: HeaderControls;
  scratch: ReturnType<typeof useScratchPads>;
  platform: Platform;
  padOpen: boolean;
  uiSettings: ReturnType<typeof useUiSettings>;
  padSizeProps: PadSizeProps;
  terminalPadRef: RefObject<TerminalPadHandle | null>;
  openSavedHandoff: (record: HandoffRecord, showText?: boolean) => void;
  openChainOverviewTab: (chainId: string) => Promise<void>;
  readTerminalVerdict: (tabId: string | null | undefined, fresh?: boolean) => void;
  openTerminalHandoff: (target: HandoffTargetId, sourceTabId?: string) => Promise<void>;
  notePadSelection: () => void;
  openPromptLibrary: (save: boolean) => void;
  focusActiveTerminal: () => void;
  onPadError: (message: string) => void;
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
  planTerminalTargets,
  terminalRoute,
  busy,
  fontSize,
  controls,
  scratch,
  platform,
  padOpen,
  uiSettings,
  padSizeProps,
  terminalPadRef,
  openSavedHandoff,
  openChainOverviewTab,
  readTerminalVerdict,
  openTerminalHandoff,
  notePadSelection,
  openPromptLibrary,
  focusActiveTerminal,
  onPadError,
}: TerminalTabViewProps) {
  const linked = handoffs.find((item) => item.targetTabId === activeTabId) ?? null;
  const launch = terminalLaunchOf(activeTabSummary);
  const terminalModelPicker = controls.modelPickerFor(activeTabSummary);
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
      {(isPlanTerminal ||
        terminalModelPicker ||
        activeTabSummary.worktreeBranch ||
        activeTabSummary.chain ||
        activeTabSummary.cwd) && (
        <div className="terminal-toolbar">
          {activeTabSummary.chain && (
            <ChainLabel
              label={chainLabel(activeTabSummary.chain)}
              onOpen={() => void openChainOverviewTab(activeTabSummary.chain!.chainId)}
            />
          )}
          {activeTabSummary.worktreeBranch && (
            <span
              className="session-branch"
              aria-label="Git branch"
              title={activeTabSummary.worktreePath ?? undefined}
            >
              ⎇ {activeTabSummary.worktreeBranch}
            </span>
          )}
          {terminalModelPicker}
          {activeTabSummary.cwd && controls.changesButton(activeTabSummary.id)}
          {activeTabSummary.cwd && controls.activityButton(activeTabSummary.id)}
          {isPlanTerminal && (
            <span
              className="terminal-handoff"
              style={{ display: "contents" }}
              onPointerOver={() => readTerminalVerdict(activeTabSummary.id)}
              onFocus={() => readTerminalVerdict(activeTabSummary.id)}
            >
              <HandoffActions
                enabled
                reason={null}
                busy={busy}
                targets={planTerminalTargets}
                primaryTarget={terminalRoute?.primaryTarget ?? null}
                primaryLabel={terminalRoute?.primaryLabel ?? null}
                completeNote={
                  terminalRoute?.complete
                    ? activeTabSummary.chain
                      ? "Chain complete: the PR Reviewer approved."
                      : "Review approved: nothing left to hand off."
                    : null
                }
                roleNames={roles}
                onSend={(target) => {
                  void openTerminalHandoff(target);
                }}
              />
            </span>
          )}
        </div>
      )}
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
        // intentionally silent: the recent-sends record is best effort.
        onSent={(text) => void promptRecordSend(text, "terminal").catch(() => {})}
        onError={onPadError}
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
    </section>
  );
}
