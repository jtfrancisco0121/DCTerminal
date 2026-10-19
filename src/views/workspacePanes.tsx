import type {
  ComponentProps,
  Dispatch,
  MutableRefObject,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react";
import type { getClaudeUsage, RoleSummary, TabSummary } from "../bridge";
import { StageTerminalView } from "./StageTerminalView";
import { chainLabel } from "../handoff/chains";
import { handoffMenuItems, type HandoffTargetId } from "../handoff/map";
import type { TabRuntime } from "../liveTabs";
import type { ProviderId } from "../provider/types";
import { SessionTerminal, type ChatFindRequest } from "../SessionTerminal";
import { closeSplit, removeFromGrid, type SplitState } from "../tabChrome";
import { tabStatusLabel, type TabStatus } from "../tabStatus";
import { livePty } from "../terminal/live";
import { contextPercent } from "../usage/limits";
import { SessionHeaderControls, type HeaderControls } from "./SessionHeaderControls";
import { terminalHeaderFor, terminalHeaderState, type TerminalHeaderDeps } from "./terminalHeader";
import { roleDisplayName } from "../handoff/transitions";
import { headerStateOf } from "../terminal/headerState";
import { PaneStrip } from "./PaneStrip";
import { PreviewSlot } from "../preview/PreviewLayer";
import { GitHubTab } from "../components/GitHubTab";
import { PaneBoundary } from "../components/PaneBoundary";
import { viewLabel } from "./paneLabel";
import { isClaudeTerminal, terminalLaunchOf } from "./tabHelpers";

/** What the second pane and the grid cells read and change in the workspace. */
export type PaneDeps = {
  runtimes: Record<string, TabRuntime>;
  roles: RoleSummary[];
  busy: boolean;
  fontSize: number;
  controls: HeaderControls;
  tabStatuses: Record<string, TabStatus>;
  focusedPane: "primary" | "secondary";
  setFocusedPane: (pane: "primary" | "secondary") => void;
  setSplit: Dispatch<SetStateAction<SplitState>>;
  splitRef: MutableRefObject<SplitState>;
  activeTabIdRef: MutableRefObject<string | null>;
  gridFocusRef: MutableRefObject<string | null>;
  secondaryInputRef: RefObject<HTMLTextAreaElement | null>;
  findRequest: { tabId: string; req: ChatFindRequest } | null;
  usageSnap: Awaited<ReturnType<typeof getClaudeUsage>> | null;
  providerOf: (tab: TabSummary | null) => ProviderId;
  isTerminalSource: (tab: TabSummary | null | undefined) => boolean;
  imagesFor: (
    tabId: string | null,
    info: { supportsImages?: boolean } | null | undefined,
  ) => ComponentProps<typeof SessionTerminal>["images"];
  handleSelectTab: (tabId: string) => Promise<void>;
  swapPanes: () => void;
  setChatSearchQuery: (query: string | null) => void;
  openChainOverviewTab: (chainId: string) => Promise<void>;
  openTerminalHandoff: (target: HandoffTargetId, sourceTabId?: string) => Promise<void>;
  respondPermissionFor: (tabId: string | null, optionId: string | null) => Promise<void>;
  respondQuestionFor: (
    tabId: string | null,
    outcome: "answered" | "skipped" | "cancelled",
    choiceId?: string,
  ) => Promise<void>;
  cancelTurnFor: (tabId: string | null) => Promise<void>;
  setFollowUpFor: (tabId: string | null, value: string) => void;
  sendFollowUpFor: (tabId: string | null) => Promise<void>;
  requestStopSecondarySession: (tabId: string) => Promise<void>;
  restartSecondarySession: (tabId: string) => Promise<void>;
  /** What the terminal header reads (R16). */
  headerDeps: TerminalHeaderDeps;
  /** A short message for the user (a link that would not open). */
  onNotice: (title: string, body: string) => void;
};

export type PaneRenderers = ReturnType<typeof createPaneRenderers>;

/**
 * Renderers for the tabs shown beside the active one: the second pane of a
 * split and the grid cells. Plain functions (not components), so a cell
 * keeps its DOM when it becomes the active cell.
 */
export function createPaneRenderers({
  runtimes,
  roles,
  busy,
  fontSize,
  controls,
  tabStatuses,
  focusedPane,
  setFocusedPane,
  setSplit,
  splitRef,
  activeTabIdRef,
  gridFocusRef,
  secondaryInputRef,
  findRequest,
  usageSnap,
  providerOf,
  isTerminalSource,
  imagesFor,
  handleSelectTab,
  swapPanes,
  setChatSearchQuery,
  openChainOverviewTab,
  openTerminalHandoff,
  respondPermissionFor,
  respondQuestionFor,
  cancelTurnFor,
  setFollowUpFor,
  sendFollowUpFor,
  requestStopSecondarySession,
  restartSecondarySession,
  headerDeps,
  onNotice,
}: PaneDeps) {
  /**
   * The thin strip on top of a pane: number, role, folder and branch, and
   * the same state pill as the tab's terminal header (chats read the tab
   * chip's status the same way).
   */
  const paneStrip = (tab: TabSummary, number: number, focused: boolean): ReactNode => {
    const plainTerminal = tab.kind === "terminal" && tab.terminalLaunch !== "role";
    const state =
      tab.kind === "terminal"
        ? terminalHeaderState(headerDeps, tab).header
        : headerStateOf({ status: tabStatuses[tab.id], turnEnded: false });
    return (
      <PaneStrip
        number={number}
        roleName={plainTerminal ? "Terminal" : roleDisplayName(tab.roleId, roles)}
        cwd={tab.cwd}
        branch={tab.worktreeBranch}
        state={state}
        focused={focused}
      />
    );
  };

  /** 1-based place of a tab in the grid. */
  const gridNumber = (tabId: string) => (splitRef.current.gridTabIds ?? []).indexOf(tabId) + 1;

  /**
   * A live view of a tab that is not the active one: the same terminal
   * process, or the running chat with its own composer. Wrapped in its own
   * PaneBoundary.
   */
  const paneBody = (
    tab: TabSummary,
    idle: ReactNode,
    inputRef?: typeof secondaryInputRef,
    permissionKeys = false,
  ): ReactNode => {
    const rt = runtimes[tab.id];
    let body: ReactNode;
    if (tab.kind === "preview") {
      // The page itself stays loaded in the PreviewLayer and is laid over this.
      body = <PreviewSlot tabId={tab.id} />;
    } else if (tab.kind === "github") {
      body = <GitHubTab onNotice={onNotice} />;
    } else if (tab.kind === "terminal") {
      const tabLaunch = terminalLaunchOf(tab);
      const needs = tabStatuses[tab.id]?.needsYou;
      body = (
        <StageTerminalView
          key={tab.id}
          tab={tab}
          needsYou={needs === "permission" || needs === "plan" || needs === "question"}
          onNotice={onNotice}
          ptyId={tab.id}
          cwd={tab.cwd}
          launch={tabLaunch}
          roleId={tab.roleId}
          fontSize={fontSize}
          resumeSessionId={tab.resumeSessionId}
          claudeSession={isClaudeTerminal(tab)}
          autoOpen={!livePty(tab.id)}
          autoFocus={false}
          menuActions={
            isTerminalSource(tab)
              ? handoffMenuItems(tab.roleId, roles, tab.chain ?? null).map((item) => ({
                  id: `send-${item.target}`,
                  label: item.label,
                  onSelect: () => {
                    void openTerminalHandoff(item.target, tab.id);
                  },
                }))
              : []
          }
        />
      );
    } else if (rt?.session) {
      const attach = rt.startResult?.injectionStrategy === "attach_to_first_message";
      body = (
        <SessionTerminal
          key={tab.id}
          title={tab.label}
          findRequest={findRequest?.tabId === tab.id ? findRequest.req : null}
          onSearchAllChats={(query) => setChatSearchQuery(query)}
          branch={tab.worktreeBranch ?? null}
          chainLabel={tab.chain ? chainLabel(tab.chain) : null}
          onOpenChain={tab.chain ? () => void openChainOverviewTab(tab.chain!.chainId) : null}
          contextFill={
            providerOf(tab) === "claude" ? contextPercent(usageSnap?.contextByTab[tab.id]) : null
          }
          cwd={rt.session.cwd}
          sessionId={rt.session.sessionId}
          segments={rt.segments}
          promptInFlight={rt.promptInFlight}
          followUp={rt.followUp}
          busy={busy}
          canSendFollowUp={!attach || !rt.startResult?.startupInjected}
          promptError={rt.promptError}
          permissionRequest={rt.permission}
          onPermissionSelect={(optionId) => void respondPermissionFor(tab.id, optionId)}
          onPermissionCancel={() => void respondPermissionFor(tab.id, null)}
          permissionKeys={permissionKeys}
          questionRequest={rt.question}
          onQuestionAnswer={(choiceId) => void respondQuestionFor(tab.id, "answered", choiceId)}
          onQuestionSkip={() => void respondQuestionFor(tab.id, "skipped")}
          onQuestionCancel={() => void respondQuestionFor(tab.id, "cancelled")}
          onCancelTurn={() => void cancelTurnFor(tab.id)}
          onFollowUpChange={(value) => setFollowUpFor(tab.id, value)}
          onSendFollowUp={() => void sendFollowUpFor(tab.id)}
          onStop={() => void requestStopSecondarySession(tab.id)}
          folderWarning={rt.folderWarning}
          agentExited={rt.agentExited}
          onRestart={() => void restartSecondarySession(tab.id)}
          inputRef={inputRef}
          slashCommands={rt.slashCommands}
          images={imagesFor(tab.id, rt.session)}
          headerExtra={<SessionHeaderControls controls={controls} tab={tab} session={rt.session} />}
        />
      );
    } else {
      body = idle;
    }
    // A crash in the view keeps the pane's strip and buttons (Swap, Close, ×).
    return (
      <PaneBoundary label={viewLabel(tab)} paneId={tab.id} resetKey={tab.id}>
        {body}
      </PaneBoundary>
    );
  };

  const renderSecondary = (tab: TabSummary) => {
    const rt = runtimes[tab.id];
    const liveChat = tab.kind !== "terminal" && !!rt?.session;
    const body = paneBody(
      tab,
      <div className="split-pane-empty">
        <p className="hint">This tab has no running session.</p>
        <button type="button" className="secondary-button" onClick={swapPanes}>
          Open in main pane
        </button>
      </div>,
      secondaryInputRef,
      focusedPane === "secondary",
    );
    const planWaiting = rt?.plan != null;
    const paneButtons = (
      <>
        <button
          type="button"
          className="secondary-button"
          onClick={swapPanes}
          title="Swap panes"
          aria-label="Swap panes"
        >
          Swap
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setSplit((current) => closeSplit(current));
            setFocusedPane("primary");
          }}
          title="Close split"
          aria-label="Close split"
        >
          Close
        </button>
      </>
    );
    return (
      <div
        className={
          focusedPane === "secondary" ? "split-pane split-pane-focused" : "split-pane split-pane-dim"
        }
        data-pane="secondary"
        aria-label={`Second pane: ${tab.label}`}
        onFocusCapture={() => setFocusedPane("secondary")}
        onMouseDown={() => setFocusedPane("secondary")}
      >
        {paneStrip(tab, 2, focusedPane === "secondary")}
        {tab.kind === "terminal" ? (
          terminalHeaderFor(headerDeps, tab, {
            compact: true,
            controls: true,
            actions: paneButtons,
          })
        ) : (
          <div className="split-pane-bar">
            <span className="split-pane-title" title={tab.cwd}>
              {tab.label}
            </span>
            {!liveChat && controls.modelPickerFor(tab)}
            <span className="split-pane-spacer" />
            {paneButtons}
          </div>
        )}
        {planWaiting && (
          <p className="hint split-pane-note">
            A plan is waiting for review. Swap panes to answer it.
          </p>
        )}
        <div className="split-pane-body">{body}</div>
      </div>
    );
  };

  /**
   * A grid cell for a tab that is not the active one: a live view plus a
   * header with its status. Any click (or focus) in it makes it the active
   * tab, which gives that cell the full controls without moving any cell.
   */
  const gridTone = (tab: TabSummary) => {
    const status = tabStatuses[tab.id];
    if (status?.exitCode != null) return "error";
    return status?.needsYou ? "needs" : status?.busy ? "busy" : status?.unseen ? "unseen" : "idle";
  };

  /** Take a tab out of the grid. Removing the active cell focuses its neighbor. */
  const removeGridCell = (tabId: string) => {
    const cells = splitRef.current.gridTabIds ?? [];
    const index = cells.indexOf(tabId);
    const neighbor = cells[index + 1] ?? cells[index - 1] ?? null;
    setSplit((current) => removeFromGrid(current, tabId));
    if (tabId === activeTabIdRef.current && neighbor) void handleSelectTab(neighbor);
  };

  const gridCellBar = (tab: TabSummary) => {
    const status = tabStatuses[tab.id];
    const tone = gridTone(tab);
    const removeButton = (
      <button
        type="button"
        className="secondary-button grid-cell-remove"
        onClick={() => removeGridCell(tab.id)}
        title="Remove from grid. The tab keeps running."
        aria-label={`Remove ${tab.label} from grid`}
      >
        ×
      </button>
    );
    const strip = paneStrip(tab, gridNumber(tab.id), tab.id === activeTabIdRef.current);
    // R25: a terminal cell gets the compact terminal header with its state and next step.
    if (tab.kind === "terminal") {
      return (
        <>
          {strip}
          {terminalHeaderFor(headerDeps, tab, {
            compact: true,
            controls: tab.id === activeTabIdRef.current,
            actions: removeButton,
          })}
        </>
      );
    }
    return (
      <>
        {strip}
        <div className="split-pane-bar">
          <span className={`grid-cell-dot grid-cell-dot-${tone}`} aria-hidden />
          <span className="split-pane-title" title={tab.cwd}>
            {tab.label}
          </span>
          {status && tone !== "idle" && (
            <span className="grid-cell-status">{tabStatusLabel(status)}</span>
          )}
          <span className="split-pane-spacer" />
          {removeButton}
        </div>
      </>
    );
  };

  const renderGridCell = (tab: TabSummary) => {
    const tone = gridTone(tab);
    const activate = (event: { target: EventTarget }) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".grid-cell-remove, .terminal-header button")
      )
        return;
      if (tab.id === activeTabIdRef.current) return;
      gridFocusRef.current =
        event.target instanceof Element && event.target.closest(".session-terminal-input")
          ? tab.id
          : null;
      void handleSelectTab(tab.id);
    };
    return (
      <div
        className={`split-pane split-pane-dim grid-cell grid-cell-${tone}`}
        data-pane="grid"
        aria-label={`Grid cell: ${tab.label}`}
        onMouseDownCapture={(event) => {
          // Fields switch tabs on focus instead: switching on mousedown re-renders the
          // cell before the browser focuses the clicked field, so focus would be lost.
          if (event.target instanceof Element && event.target.closest("textarea, input, select"))
            return;
          activate(event);
        }}
        onFocusCapture={activate}
      >
        {gridCellBar(tab)}
        <div className="split-pane-body">
          {paneBody(
            tab,
            <div className="split-pane-empty">
              <p className="hint">Not started. Click to open it here.</p>
            </div>,
          )}
        </div>
      </div>
    );
  };

  return { paneBody, paneStrip, renderSecondary, gridTone, gridCellBar, renderGridCell };
}
