import type { ReactNode } from "react";
import type { RoleSummary, TabSummary, TerminalSessionLog } from "../bridge";
import { ChainLabel } from "../components/ChainLabel";
import { TerminalHeader, type NextStep } from "../components/TerminalHeader";
import { chainLabel } from "../handoff/chains";
import { handoffTargets, type HandoffTargetId } from "../handoff/map";
import { handoffRoute } from "../handoff/routing";
import { roleDisplayName } from "../handoff/transitions";
import type { ReviewVerdict } from "../handoff/verdict";
import type { TerminalState } from "../terminal/claudeState";
import type { TerminalViewMode } from "../terminal/chatEntries";
import { headerStateOf, headerWorking, type HeaderState } from "../terminal/headerState";
import type { TabStatus } from "../tabStatus";
import type { HeaderControls } from "./SessionHeaderControls";
import { isClaudeTerminal } from "./tabHelpers";
import { SubAgentIndicator, TerminalViewSwitch } from "./TerminalChatView";
import { runIdOfTab } from "../pipeline/planPane";
import { PlanPaneToggle } from "./PlanPane";

/** What a terminal header reads from the workspace. */
export type TerminalHeaderDeps = {
  roles: RoleSummary[];
  roleColors: Record<string, string>;
  controls: HeaderControls;
  terminalStates: Record<string, TerminalState>;
  tabStatuses: Record<string, TabStatus>;
  /** When each working terminal's turn started (ms), by tab id. */
  workingSince: Record<string, number>;
  sessionLogs: Record<string, TerminalSessionLog | null>;
  /** The reviewer verdict read last (for one tab). */
  terminalVerdict: { tabId: string; verdict: ReviewVerdict | null } | null;
  isTerminalSource: (tab: TabSummary | null | undefined) => boolean;
  busy: boolean;
  openTerminalHandoff: (target: HandoffTargetId, sourceTabId?: string) => Promise<void>;
  openChainOverviewTab: (chainId: string) => Promise<void>;
  readTerminalVerdict: (tabId: string | null | undefined, fresh?: boolean) => void;
  /** Interrupt a terminal's running turn. */
  stopTerminalTurn: (tabId: string) => void;
  /** Terminal or Chat, per Claude terminal tab (absent: Terminal). */
  terminalViews?: Record<string, TerminalViewMode>;
  setTerminalView?: (tabId: string, view: TerminalViewMode) => void;
};

export type TerminalHeaderOptions = {
  compact?: boolean;
  /** Model, Changes and Activity beside the state (the active tab). */
  controls?: boolean;
  actions?: ReactNode;
  /**
   * The Terminal · Chat switch and, on a pipeline tab, the Plan pane toggle
   * (the tab's own header, not a grid cell).
   */
  viewSwitch?: boolean;
};

export function folderName(cwd: string | undefined | null): string | null {
  const parts = (cwd ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** The tab's state pill; the chat view reads its Needs you from here too. */
export function terminalHeaderState(
  deps: Pick<TerminalHeaderDeps, "terminalVerdict" | "sessionLogs" | "terminalStates" | "tabStatuses">,
  tab: TabSummary,
): { header: HeaderState; turnEnded: boolean; working: boolean } {
  const isRole = tab.terminalLaunch === "role";
  const verdict = deps.terminalVerdict?.tabId === tab.id ? deps.terminalVerdict.verdict : null;
  const log = deps.sessionLogs[tab.id];
  const state = deps.terminalStates[tab.id];
  const turnEnded = isRole && state?.kind === "idle" && !!log?.turnDone;
  const header = headerStateOf({
    state,
    status: deps.tabStatuses[tab.id],
    turnEnded,
    verdict,
  });
  // An unknown turn may still be running: the composer keeps Stop and Queue.
  return { header, turnEnded, working: headerWorking(header) };
}

/** The R16 header of one terminal tab, for the tab itself, the second pane or a grid cell. */
export function terminalHeaderFor(
  deps: TerminalHeaderDeps,
  tab: TabSummary,
  { compact = false, controls = true, actions, viewSwitch = false }: TerminalHeaderOptions = {},
): ReactNode {
  const isRole = tab.terminalLaunch === "role";
  const roleName = isRole ? roleDisplayName(tab.roleId, deps.roles) : "Terminal";
  const verdict = deps.terminalVerdict?.tabId === tab.id ? deps.terminalVerdict.verdict : null;
  const { header, turnEnded } = terminalHeaderState(deps, tab);
  const claude = isClaudeTerminal(tab);
  const setView = deps.setTerminalView;
  const terminalChatSwitch =
    claude && viewSwitch && setView ? (
      <TerminalViewSwitch
        tabId={tab.id}
        view={deps.terminalViews?.[tab.id] ?? "terminal"}
        onChange={(view) => setView(tab.id, view)}
      />
    ) : null;
  const planToggle = viewSwitch && runIdOfTab(tab) ? <PlanPaneToggle tabId={tab.id} /> : null;

  let next: NextStep | null = null;
  if (deps.isTerminalSource(tab)) {
    const targets = handoffTargets(tab.roleId, deps.roles, tab.chain ?? null);
    const route = handoffRoute({
      sourceRoleId: tab.roleId,
      targets,
      verdict,
      chain: tab.chain ?? null,
      roles: deps.roles,
    });
    next = {
      targets: targets.map((id) => ({
        id,
        name: roleDisplayName(id, deps.roles),
      })),
      primaryTarget: route.primaryTarget,
      primaryLabel: route.primaryLabel,
      completeNote: route.complete
        ? tab.chain
          ? "Chain complete: the PR Reviewer approved."
          : "Review approved: nothing left to hand off."
        : null,
      busy: deps.busy,
      onSend: (target) => {
        void deps.openTerminalHandoff(target as HandoffTargetId, tab.id);
      },
    };
  }

  return (
    <TerminalHeader
      compact={compact}
      roleName={roleName}
      roleColor={tab.color || deps.roleColors[tab.roleId] || "#8b949e"}
      title={
        tab.label.startsWith(`${roleName} · `) ? tab.label.slice(roleName.length + 3) : tab.label
      }
      state={header}
      workingSince={deps.workingSince[tab.id] ?? null}
      folder={folderName(tab.cwd)}
      folderTitle={tab.cwd}
      branch={tab.worktreeBranch}
      branchTitle={tab.worktreePath ?? undefined}
      // Not in a compact header (grid cell, second pane): each indicator keeps
      // a session-log watch of its own, and only the tab's own header needs one.
      badges={claude && !compact ? <SubAgentIndicator tabId={tab.id} /> : null}
      viewSwitch={
        terminalChatSwitch || planToggle ? (
          <>
            {terminalChatSwitch}
            {planToggle}
          </>
        ) : null
      }
      chain={
        tab.chain ? (
          <ChainLabel
            label={chainLabel(tab.chain)}
            onOpen={() => void deps.openChainOverviewTab(tab.chain!.chainId)}
          />
        ) : null
      }
      right={
        controls ? (
          <>
            {deps.controls.modelPickerFor(tab)}
            {tab.cwd && deps.controls.changesButton(tab.id)}
            {tab.cwd && deps.controls.activityButton(tab.id)}
          </>
        ) : null
      }
      next={next}
      turnEnded={turnEnded}
      onStop={isRole ? () => deps.stopTerminalTurn(tab.id) : null}
      actions={actions}
      onPrepare={() => deps.readTerminalVerdict(tab.id)}
    />
  );
}
