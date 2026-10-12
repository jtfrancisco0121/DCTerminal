import type {
  ComponentProps,
  Dispatch,
  MutableRefObject,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react";
import type { DevSessionInfo, getClaudeUsage, TabSummary } from "../bridge";
import { InlineNotice } from "../components/InlineNotice";
import { ScratchPad } from "../components/ScratchPad";
import { SessionCards } from "../components/SessionCards";
import { SplitPanes } from "../components/SplitPanes";
import { TerminalView } from "../components/TerminalView";
import { stopReasonText } from "../chatStatus";
import { chainLabel } from "../handoff/chains";
import type { TabRuntime } from "../liveTabs";
import type { ProviderId } from "../provider/types";
import { chainStop, type ChainCursor } from "../scratch/pad";
import { emptySessionCards, type SessionCards as Cards } from "../sessionCards";
import { SessionTerminal, type ChatFindRequest } from "../SessionTerminal";
import { contextPercent } from "../usage/limits";
import type { useScratchPads } from "../useScratchPads";
import type { useUiSettings } from "../useUiSettings";
import { SessionHeaderControls, type HeaderControls } from "./SessionHeaderControls";
import type { PadSizeProps } from "./tabHelpers";

type TerminalProps = ComponentProps<typeof SessionTerminal>;

export type ChatSessionViewProps = {
  activeTabId: string | null;
  activeTabSummary: TabSummary | null | undefined;
  activeRuntime: TabRuntime;
  /** The running chat session of the active tab. */
  session: DevSessionInfo;
  handoffBanner: ReactNode;
  cardsByTab: Record<string, Cards>;
  handoffOffer: ComponentProps<typeof SessionCards>["handoff"];
  paneByTab: Record<string, { open: boolean; beside: boolean }>;
  setPaneByTab: Dispatch<SetStateAction<Record<string, { open: boolean; beside: boolean }>>>;
  togglePane: () => void;
  findRequest: { tabId: string; req: ChatFindRequest } | null;
  setChatSearchQuery: (query: string | null) => void;
  openChainOverviewTab: (chainId: string) => Promise<void>;
  activeProvider: ProviderId;
  usageSnap: Awaited<ReturnType<typeof getClaudeUsage>> | null;
  busy: boolean;
  fontSize: number;
  roleId: string;
  roleNames: Record<string, string>;
  modelForTab: (tab: TabSummary) => string | null;
  controls: HeaderControls;
  imagesFor: (
    tabId: string | null,
    info: { supportsImages?: boolean } | null | undefined,
  ) => TerminalProps["images"];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  padRef: RefObject<HTMLTextAreaElement | null>;
  composerHistory: string[];
  historyCursor: number;
  setHistoryCursor: (cursor: number) => void;
  scratch: ReturnType<typeof useScratchPads>;
  chain: ChainCursor | null;
  setChain: Dispatch<SetStateAction<ChainCursor | null>>;
  chainAbortRef: MutableRefObject<boolean>;
  padOpen: boolean;
  uiSettings: ReturnType<typeof useUiSettings>;
  padSizeProps: PadSizeProps;
  transcriptSaveError: string | null;
  respondPlanFor: (tabId: string | null, outcome: "accepted" | "cancelled") => Promise<void>;
  handlePermissionSelect: TerminalProps["onPermissionSelect"];
  handlePermissionCancel: TerminalProps["onPermissionCancel"];
  handleQuestionAnswer: NonNullable<TerminalProps["onQuestionAnswer"]>;
  handleQuestionSkip: NonNullable<TerminalProps["onQuestionSkip"]>;
  handleQuestionCancel: NonNullable<TerminalProps["onQuestionCancel"]>;
  cancelTurn: () => Promise<void>;
  setFollowUp: (value: string) => void;
  sendFollowUp: TerminalProps["onSendFollowUp"];
  stopSession: TerminalProps["onStop"];
  restartSession: () => void;
  transferPad: () => void;
  transferToTerminalNow: () => Promise<void>;
  sendFromPad: () => void;
  notePadSelection: () => void;
  openPromptLibrary: (save: boolean) => void;
};

/** The active tab's running chat: cards, transcript and composer, optional shell pane, scratch pad. */
export function ChatSessionView({
  activeTabId,
  activeTabSummary,
  activeRuntime,
  session,
  handoffBanner,
  cardsByTab,
  handoffOffer,
  paneByTab,
  setPaneByTab,
  togglePane,
  findRequest,
  setChatSearchQuery,
  openChainOverviewTab,
  activeProvider,
  usageSnap,
  busy,
  fontSize,
  roleId,
  roleNames,
  modelForTab,
  controls,
  imagesFor,
  inputRef,
  padRef,
  composerHistory,
  historyCursor,
  setHistoryCursor,
  scratch,
  chain,
  setChain,
  chainAbortRef,
  padOpen,
  uiSettings,
  padSizeProps,
  transcriptSaveError,
  respondPlanFor,
  handlePermissionSelect,
  handlePermissionCancel,
  handleQuestionAnswer,
  handleQuestionSkip,
  handleQuestionCancel,
  cancelTurn,
  setFollowUp,
  sendFollowUp,
  stopSession,
  restartSession,
  transferPad,
  transferToTerminalNow,
  sendFromPad,
  notePadSelection,
  openPromptLibrary,
}: ChatSessionViewProps) {
  const startResult = activeRuntime.startResult;
  const promptInFlight = activeRuntime.promptInFlight;
  const lastPromptResult = activeRuntime.lastResult;
  const promptError = activeRuntime.promptError;
  const followUp = activeRuntime.followUp;
  const streamSegments = activeRuntime.segments;
  const permissionRequest = activeRuntime.permission;
  const planRequest = activeRuntime.plan;
  const questionRequest = activeRuntime.question;
  // The plan card carries the hand-off buttons, so the last reply does not repeat them.
  const planHandoffInCard =
    !!planRequest && (!!planRequest.markdown?.trim() || !!planRequest.keepOptionId);
  const attachFirst = startResult?.injectionStrategy === "attach_to_first_message";
  return (
    <section className="status-card status-card-session-full">
      {handoffBanner}
      <SessionCards
        cards={cardsByTab[activeTabId ?? ""] ?? emptySessionCards()}
        segments={streamSegments}
        planRequest={planRequest}
        busy={busy}
        onAcceptPlan={() => void respondPlanFor(activeTabId, "accepted")}
        onRejectPlan={() => void respondPlanFor(activeTabId, "cancelled")}
        handoff={handoffOffer}
      />
      <SplitPanes
        mode={
          paneByTab[activeTabId ?? ""]?.open
            ? paneByTab[activeTabId ?? ""]?.beside
              ? "horizontal"
              : "vertical"
            : "single"
        }
        primary={
          <SessionTerminal
            title={activeTabSummary?.label ?? "Session"}
            scrollKey={activeTabId}
            findRequest={activeTabId && findRequest?.tabId === activeTabId ? findRequest.req : null}
            onSearchAllChats={(query) => setChatSearchQuery(query)}
            branch={activeTabSummary?.worktreeBranch ?? null}
            chainLabel={activeTabSummary?.chain ? chainLabel(activeTabSummary.chain) : null}
            onOpenChain={
              activeTabSummary?.chain
                ? () => void openChainOverviewTab(activeTabSummary.chain!.chainId)
                : null
            }
            contextFill={
              activeProvider === "claude" && activeTabId
                ? contextPercent(usageSnap?.contextByTab[activeTabId])
                : null
            }
            cwd={session.cwd}
            sessionId={session.sessionId}
            segments={streamSegments}
            promptInFlight={promptInFlight}
            followUp={followUp}
            busy={busy}
            canSendFollowUp={!attachFirst || !startResult?.startupInjected}
            promptError={promptError}
            permissionRequest={permissionRequest}
            onPermissionSelect={handlePermissionSelect}
            onPermissionCancel={handlePermissionCancel}
            questionRequest={questionRequest}
            onQuestionAnswer={handleQuestionAnswer}
            onQuestionSkip={handleQuestionSkip}
            onQuestionCancel={handleQuestionCancel}
            onCancelTurn={cancelTurn}
            onFollowUpChange={setFollowUp}
            onSendFollowUp={sendFollowUp}
            onStop={stopSession}
            folderWarning={activeRuntime.folderWarning}
            agentExited={activeRuntime.agentExited}
            onRestart={restartSession}
            inputRef={inputRef}
            slashCommands={activeRuntime.slashCommands}
            history={composerHistory}
            historyCursor={historyCursor}
            onHistoryCursor={setHistoryCursor}
            handoff={planHandoffInCard ? null : handoffOffer}
            images={imagesFor(activeTabId, session)}
            statusInBar
            details={[
              `Role: ${roleNames[roleId] ?? roleId}`,
              `Model: ${session.model ?? (activeTabSummary ? modelForTab(activeTabSummary) : "") ?? ""}`,
            ].join("\n")}
            headerExtra={
              <SessionHeaderControls controls={controls} tab={activeTabSummary} session={session} />
            }
          />
        }
        secondary={
          paneByTab[activeTabId ?? ""]?.open && activeTabId ? (
            <div className="terminal-pane">
              <div className="terminal-pane-bar">
                <span>Terminal</span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    const tabId = activeTabId;
                    setPaneByTab((prev) => {
                      const current = prev[tabId] ?? { open: true, beside: false };
                      return { ...prev, [tabId]: { ...current, beside: !current.beside } };
                    });
                  }}
                >
                  {paneByTab[activeTabId]?.beside ? "Below" : "Beside"}
                </button>
                <button type="button" className="secondary-button" onClick={togglePane}>
                  Hide
                </button>
              </div>
              <TerminalView
                ptyId={`${activeTabId}::pane`}
                cwd={session.cwd}
                launch="shell"
                fontSize={fontSize}
                autoOpen
                autoFocus={false}
              />
            </div>
          ) : null
        }
      />
      <ScratchPad
        ref={padRef}
        content={scratch.content}
        truncated={scratch.truncated}
        persistError={scratch.persistError}
        chain={chain}
        disabled={busy || !!permissionRequest}
        onChange={(value) => {
          if (activeTabId) scratch.setContent(activeTabId, value);
        }}
        onTransfer={transferPad}
        slashCommands={activeRuntime.slashCommands}
        onTransferTerminal={() => void transferToTerminalNow()}
        onSend={sendFromPad}
        onBlur={() => {
          notePadSelection();
          scratch.flush();
        }}
        onOpenLibrary={() => openPromptLibrary(false)}
        images={imagesFor(activeTabId, session)}
        showImageChips={false}
        collapsed={!padOpen}
        onToggle={() => uiSettings.update({ padHidden: padOpen })}
        {...padSizeProps}
        onStopChain={() => {
          chainAbortRef.current = true;
          setChain((current) => (current ? chainStop(current) : current));
          void cancelTurn();
        }}
      />
      {transcriptSaveError && (
        <InlineNotice tone="error">Could not save the transcript: {transcriptSaveError}</InlineNotice>
      )}
      {lastPromptResult && !promptInFlight && (
        <p className="hint session-turn-hint">{stopReasonText(lastPromptResult.stopReason)}</p>
      )}
    </section>
  );
}
