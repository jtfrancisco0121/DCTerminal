import type { ReactNode } from "react";
import { acpSetEffort, type DevSessionInfo, type TabSummary } from "../bridge";
import { ActivityButton } from "../components/ActivityButton";
import { errorText } from "../components/InlineNotice";
import { ModelPicker } from "../components/ModelPicker";
import type { TabRuntime } from "../liveTabs";
import type { AgentEventKind } from "../notify/agentNotify";
import type { modelsForProvider } from "../provider/descriptor";
import type { ProviderId } from "../provider/types";
import { modeLabel, type SessionCards as Cards } from "../sessionCards";
import type { TabStatus } from "../tabStatus";
import { tabHasModel } from "./tabHelpers";

/** What the session header controls read and change in the workspace. */
export type HeaderControlDeps = {
  busy: boolean;
  savedTabs: TabSummary[];
  runtimes: Record<string, TabRuntime>;
  cardsByTab: Record<string, Cards>;
  tabStatuses: Record<string, TabStatus>;
  changeCounts: Record<string, number>;
  activityTabId: string | null;
  setChangesTabId: (tabId: string | null) => void;
  setActivityTabId: (tabId: string | null) => void;
  providerOf: (tab: TabSummary | null) => ProviderId;
  inheritedModel: (tab: TabSummary | null | undefined) => string;
  modelsForTab: (tab: TabSummary | null | undefined) => ReturnType<typeof modelsForProvider>;
  changeTabModel: (tab: TabSummary, model: string | null) => Promise<void>;
  patchRuntime: (tabId: string, update: (rt: TabRuntime) => TabRuntime) => void;
  showNotice: (title: string, body: string, kind?: AgentEventKind) => void;
};

export type HeaderControls = ReturnType<typeof headerControls>;

/**
 * The per-tab header controls (mode badge, model and effort pickers,
 * Changes and Activity), shared by the chat header, the second pane and
 * the terminal toolbar.
 */
export function headerControls({
  busy,
  savedTabs,
  runtimes,
  cardsByTab,
  tabStatuses,
  changeCounts,
  activityTabId,
  setChangesTabId,
  setActivityTabId,
  providerOf,
  inheritedModel,
  modelsForTab,
  changeTabModel,
  patchRuntime,
  showNotice,
}: HeaderControlDeps) {
  const changesButton = (tabId: string) => {
    const count = changeCounts[tabId] ?? 0;
    return (
      <button
        type="button"
        className="secondary-button changes-button"
        onClick={() => setChangesTabId(tabId)}
        title="Files changed since the last turn started: review, accept, or revert"
      >
        {count > 0 ? `Changes (${count})` : "Changes"}
      </button>
    );
  };

  const activityButton = (tabId: string) => (
    <ActivityButton
      tabId={tabId}
      busy={!!tabStatuses[tabId]?.busy}
      terminal={savedTabs.find((tab) => tab.id === tabId)?.kind === "terminal"}
      refreshKey={activityTabId}
      onOpen={() => setActivityTabId(tabId)}
    />
  );

  /** Claude chat: badge with the permission mode the agent last reported. */
  const modeBadgeFor = (tab: TabSummary | null | undefined, startMode?: string | null) => {
    if (!tab || providerOf(tab) !== "claude") return null;
    const mode = cardsByTab[tab.id]?.mode ?? startMode ?? null;
    if (!mode) return null;
    return (
      <span className="mode-badge" title={`Claude permission mode: ${mode}`}>
        {modeLabel(mode)}
      </span>
    );
  };

  const modelPickerFor = (tab: TabSummary | null | undefined, liveModel?: string | null) => {
    if (!tab || !tabHasModel(tab)) return null;
    const inherited = inheritedModel(tab);
    const models = modelsForTab(tab);
    return (
      <ModelPicker
        compact
        models={models}
        value={liveModel && liveModel !== (tab.model ?? inherited) ? liveModel : (tab.model ?? null)}
        inherited={{ model: inherited, label: "Default" }}
        ariaLabel={`Model for ${tab.label}`}
        disabled={busy || !!runtimes[tab.id]?.promptInFlight}
        onChange={(model) => void changeTabModel(tab, model)}
      />
    );
  };

  /** Claude chats: reasoning effort for this session (the role default applies at start). */
  const effortPickerFor = (
    tab: TabSummary | null | undefined,
    session?: { effort?: string | null; effortOptions?: string[] } | null,
  ) => {
    const options = session?.effortOptions ?? [];
    if (!tab || !session || options.length === 0) return null;
    const current = session.effort ?? "default";
    return (
      <select
        className="effort-select"
        aria-label={`Effort for ${tab.label}`}
        title="Reasoning effort for this session. Set a default per role in Settings > Models."
        value={current}
        disabled={busy || !!runtimes[tab.id]?.promptInFlight}
        onChange={(event) => {
          const next = event.target.value;
          void acpSetEffort(tab.id, next)
            .then((effort) =>
              patchRuntime(tab.id, (rt) =>
                rt.session ? { ...rt, session: { ...rt.session, effort } } : rt,
              ),
            )
            .catch((err: unknown) =>
              showNotice(
                "Effort not changed",
                errorText(err),
                "failed",
              ),
            );
        }}
      >
        {options.map((level) => (
          <option key={level} value={level}>
            {level === "default" ? "Effort: default" : `Effort: ${level}`}
          </option>
        ))}
      </select>
    );
  };

  return { changesButton, activityButton, modeBadgeFor, modelPickerFor, effortPickerFor };
}

/** The controls at the right of a chat session's header. */
export function SessionHeaderControls({
  controls,
  tab,
  session,
}: {
  controls: HeaderControls;
  tab: TabSummary | null | undefined;
  session: DevSessionInfo;
}): ReactNode {
  return (
    <>
      {controls.modeBadgeFor(tab, session.modeId)}
      {controls.modelPickerFor(tab, session.model)}
      {controls.effortPickerFor(tab, session)}
      {tab && controls.changesButton(tab.id)}
      {tab && controls.activityButton(tab.id)}
    </>
  );
}
