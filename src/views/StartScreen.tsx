import { useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import {
  setTabModel,
  setTabProvider,
  type DevSessionInfo,
  type FieldError,
  type HandoffRecord,
  type ModelList,
  type ProviderModelSettings,
  type Role,
  type RoleSummary,
  type TabSummary,
  type ValidatePreviewResult,
} from "../bridge";
import { ClickUpIntake } from "../components/ClickUpIntake";
import { SizePicker } from "../components/SizePicker";
import { eagleStartChain } from "../pipeline/eagleStart";
import { pipelineDef } from "../pipeline/defs";
import { roleForSize, startSizeView } from "../pipeline/sizes";
import { tickedTickets } from "../clickup/intakeModel";
import type { IntakeDraft } from "../clickup/intakeModel";
import { CursorHistoryList } from "../components/CursorHistoryList";
import { FolderPicker } from "../components/FolderPicker";
import { WorkspaceLine } from "../components/WorkspaceLine";
import { errorText } from "../components/InlineNotice";
import { ModelPicker } from "../components/ModelPicker";
import { RadioGroup, radioProps } from "../components/RadioGroup";
import { RoleTiles } from "../components/RoleTiles";
import { TranscriptView } from "../components/TranscriptView";
import type { CursorHistoryEntry } from "../cursorHistory";
import { roleDisplayName, type HandoffSurface } from "../handoff/map";
import { folderTabNotice } from "../liveTabs";
import { effectiveModelFor } from "../models";
import { CHOOSE_FOLDER_PROMPT, folderForTab } from "../projectsView";
import { modelsForProvider, PROVIDERS } from "../provider/descriptor";
import { PROVIDER_IDS, type ProviderId } from "../provider/types";
import type { ProvidersState } from "../provider/useProviders";
import type { useScratchPads } from "../useScratchPads";
import { formTextOf, showStartupFields, type TabDraft, type tabSurface } from "../workspaceView";
import { CLI_LABEL, visibleFields, type CliLaunch } from "./tabHelpers";

type TranscriptFocus = {
  tabId: string;
  query: string;
  occurrence: number;
  text: string;
  nonce: number;
};

export type StartScreenProps = {
  /** The chosen role (loaded). */
  role: Role;
  roles: RoleSummary[];
  activeTabId: string | null;
  activeTabIdRef: MutableRefObject<string | null>;
  activeTabSummary: TabSummary | null | undefined;
  session: DevSessionInfo | null;
  busy: boolean;
  /** A chat session is being started (Start was pressed, the agent is not up yet). */
  starting?: boolean;
  cliFound: boolean;
  providers: ProvidersState;
  activeProvider: ProviderId;
  modelList: ModelList | null;
  claudeModelList: ModelList | null;
  modelSettings: ProviderModelSettings | null;
  setModelNotice: (notice: string | null) => void;
  refreshTabs: () => Promise<unknown>;
  /** Form values of the active tab. */
  values: Record<string, string>;
  formValues: Record<string, string>;
  setField: (key: string, value: string) => void;
  errors: FieldError[];
  surface: ReturnType<typeof tabSurface>;
  newSessionOpen: boolean;
  openNewSessionForm: () => void;
  canContinueSession: boolean;
  savedTranscript: string;
  focusedTranscript: string;
  transcriptFocus: TranscriptFocus | null;
  preview: ValidatePreviewResult | null;
  previewBusy: boolean;
  runPreview: () => void;
  resendStartup: boolean;
  setResendStartup: (checked: boolean) => void;
  draftsRef: MutableRefObject<Record<string, TabDraft>>;
  previousAnswersRef: MutableRefObject<Record<string, Record<string, string>>>;
  clearedForm: { tabId: string; values: Record<string, string> } | null;
  fillPreviousValues: () => void;
  clearForm: () => void;
  undoClearForm: () => void;
  roleId: string;
  pickedRoleId: string | null;
  setPickedRoleId: (id: string | null) => void;
  chooseRole: (id: string) => void;
  launchChoice: "shell" | CliLaunch | null;
  setLaunchChoice: (choice: "shell" | CliLaunch | null) => void;
  rememberedSurface: (id: string) => HandoffSurface;
  rememberSurface: (id: string, surface: HandoffSurface) => void;
  eagleOn: boolean;
  setEagleOn: (on: boolean) => void;
  eagleOnRef: MutableRefObject<boolean>;
  /** C2: the "Tickets from ClickUp" box, which an Eagle-mode Start reads. */
  intakeDraftRef: MutableRefObject<IntakeDraft>;
  /** Opens Settings › Integrations (ClickUp is not set up for this window's account). */
  openIntegrations: () => void;
  startSession: (forceResend?: boolean, resume?: { resumeStored?: boolean }) => Promise<unknown>;
  startRoleTerminal: () => Promise<unknown>;
  startBlankTerminal: (launch: "shell" | CliLaunch) => Promise<unknown>;
  activeHandoff: HandoffRecord | null;
  handoffBanner: ReactNode;
  scratch: ReturnType<typeof useScratchPads>;
  historyFolder: string;
  historyProvider: ProviderId;
  setHistoryOverride: (provider: ProviderId | null) => void;
  historyEntries: CursorHistoryEntry[];
  historyError: string | null;
  /** The folder's history is being read. */
  historyLoading?: boolean;
  historyReadFrom: string | null;
  resumeHistoryEntry: (entry: CursorHistoryEntry) => Promise<unknown>;
  openCursorCli: (sessionId: string, cwd: string, source?: string) => Promise<unknown>;
  cliLaunchNote: string | null;
  terminalError: string | null;
  transcriptSaveError: string | null;
  emptyStateRef: RefObject<HTMLDivElement | null>;
  ignoreScrollRef: MutableRefObject<boolean>;
  scrollPositions: MutableRefObject<Record<string, number>>;
};

/**
 * The start screen of a tab with no running session: folder, role tiles,
 * the role's fields, Start, and the folder's chat history.
 */
export function StartScreen({
  role,
  roles,
  activeTabId,
  activeTabIdRef,
  activeTabSummary,
  session,
  busy,
  starting = false,
  cliFound,
  providers,
  activeProvider,
  modelList,
  claudeModelList,
  modelSettings,
  setModelNotice,
  refreshTabs,
  values,
  formValues,
  setField,
  errors,
  surface,
  newSessionOpen,
  openNewSessionForm,
  canContinueSession,
  savedTranscript,
  focusedTranscript,
  transcriptFocus,
  preview,
  previewBusy,
  runPreview,
  resendStartup,
  setResendStartup,
  draftsRef,
  previousAnswersRef,
  clearedForm,
  fillPreviousValues,
  clearForm,
  undoClearForm,
  roleId,
  pickedRoleId,
  setPickedRoleId,
  chooseRole,
  launchChoice,
  setLaunchChoice,
  rememberedSurface,
  rememberSurface,
  eagleOn,
  setEagleOn,
  eagleOnRef,
  intakeDraftRef,
  openIntegrations,
  startSession,
  startRoleTerminal,
  startBlankTerminal,
  activeHandoff,
  handoffBanner,
  scratch,
  historyFolder,
  historyProvider,
  setHistoryOverride,
  historyEntries,
  historyError,
  historyLoading = false,
  historyReadFrom,
  resumeHistoryEntry,
  openCursorCli,
  cliLaunchNote,
  terminalError,
  transcriptSaveError,
  emptyStateRef,
  ignoreScrollRef,
  scrollPositions,
}: StartScreenProps) {
  const showFields = showStartupFields({ surface, newSessionOpen });
  // F3: the tickets ticked in the ClickUp box, for the size suggestion.
  const [intakeTickets, setIntakeTickets] = useState(() => tickedTickets(intakeDraftRef.current).length);
  const displayedFolder = folderForTab(values.cwd);
  const folderNotice = folderTabNotice({
    status: activeTabSummary?.folderStatus ?? "",
    savedCwd: activeTabSummary?.cwd ?? "",
    displayedCwd: displayedFolder,
  });

  const launchTitle =
    launchChoice === "shell"
      ? "New terminal"
      : launchChoice
        ? `New ${CLI_LABEL[launchChoice]} session`
        : null;
  const pickedRoleName = roles.find((item) => item.id === pickedRoleId)?.name;
  const startTitle =
    launchTitle ?? (pickedRoleName ? `New ${pickedRoleName} session` : "Start a session");

  const composerFields = (
    <div className="composer-fields">
      {showFields && visibleFields(role, formValues).map((field) => (
        <label
          key={field.key}
          className={`field-label${field.type === "multiline" ? " field-label-wide" : ""}`}
        >
          {field.label}
          {field.required ? " *" : ""}
          {field.type === "multiline" ? (
            <textarea
              className="text-input prompt-area"
              rows={3}
              data-field-key={field.key}
              value={values[field.key] ?? ""}
              onChange={(e) => setField(field.key, e.target.value)}
              disabled={!!session || busy}
            />
          ) : field.type === "select" && field.options ? (
            <select
              className="text-input"
              value={values[field.key] ?? ""}
              onChange={(e) => setField(field.key, e.target.value)}
              disabled={!!session || busy}
            >
              <option value="">Select…</option>
              {field.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="text-input"
              type="text"
              data-field-key={field.key}
              value={values[field.key] ?? ""}
              onChange={(e) => setField(field.key, e.target.value)}
              disabled={!!session || busy}
            />
          )}
        </label>
      ))}

      {showFields && errors.length > 0 && (
        <ul className="field-errors">
          {errors.map((e) => (
            <li key={`${e.key}-${e.message}`}>
              {e.key.startsWith("_") ? null : <strong>{e.key}: </strong>}
              {e.message}
            </li>
          ))}
        </ul>
      )}

      </div>
  );

  const blankRoleKey =
    launchChoice === "cursor-cli" || launchChoice === "claude-cli"
      ? launchChoice
      : launchChoice === "shell"
        ? null
        : roleId || null;
  const blankProvider: ProviderId =
    launchChoice === "cursor-cli"
      ? "cursor"
      : launchChoice === "claude-cli"
        ? "claude"
        : activeProvider;
  const blankModelPicker =
    activeTabSummary && blankRoleKey ? (
      <ModelPicker
        compact
        models={modelsForProvider(blankProvider, modelList?.models ?? [], claudeModelList?.models)}
        value={activeTabSummary.model ?? null}
        inherited={{
          model: effectiveModelFor(blankProvider, modelSettings, blankRoleKey, null),
          label: "Default",
        }}
        ariaLabel="Model for this tab"
        disabled={busy}
        onChange={(model) => {
          const tabId = activeTabSummary.id;
          void setTabModel(tabId, model)
            .then(() => refreshTabs())
            .catch((err: unknown) =>
              setModelNotice(errorText(err)),
            );
        }}
      />
    ) : null;

  const restoreActions = surface === "restore" && (
    <div className="restore-compact">
      <div className="button-row">
        {canContinueSession && (
          <button
            type="button"
            className="primary-button"
            onClick={() => void startSession(false, { resumeStored: true })}
            disabled={busy || !cliFound}
            title="Continues this session in DCTerminal."
          >
            Continue session
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          aria-expanded={newSessionOpen}
          onClick={openNewSessionForm}
          disabled={busy}
        >
          Start new session
        </button>
      </div>
      {savedTranscript && !activeTabSummary?.acpSessionId && (
        <p className="hint">
          This tab has saved text, but it cannot be continued. Start a new session.
        </p>
      )}
      {(savedTranscript || focusedTranscript) && (
        <details
          className="startup-form-details"
          open={focusedTranscript ? true : undefined}
          key={transcriptFocus?.tabId === activeTabId ? `focus-${transcriptFocus?.nonce}` : "plain"}
        >
          <summary>Last session transcript (read-only)</summary>
          {transcriptFocus && focusedTranscript ? (
            <TranscriptView
              text={savedTranscript || focusedTranscript}
              query={transcriptFocus.query}
              occurrence={transcriptFocus.occurrence}
              label="Saved transcript"
            />
          ) : (
            <pre className="mono-snippet transcript-preview">{savedTranscript}</pre>
          )}
        </details>
      )}
    </div>
  );

  const previewButton = showFields && (
    <button
      type="button"
      className="secondary-button start-preview-button"
      onClick={runPreview}
      disabled={busy || previewBusy}
      aria-label="Validate & preview"
      title="Check the fields and show the merged startup prompt"
    >
      {previewBusy ? "…" : "Preview"}
    </button>
  );

  const chooseProvider = (provider: ProviderId) => {
    if (!activeTabSummary || provider === activeProvider) return;
    const tabId = activeTabSummary.id;
    // A model id from one provider means nothing to the other.
    const resetModel = activeTabSummary.model ? setTabModel(tabId, null) : Promise.resolve("");
    void resetModel
      .then(() => setTabProvider(tabId, provider, pickedRoleId || roleId || null))
      .then(() => refreshTabs())
      .then(() => providers.refreshSettings())
      .catch((err: unknown) => setModelNotice(errorText(err)));
  };
  const providerChip =
    activeTabSummary && activeTabSummary.phase === "draft" && showFields ? (
      <RadioGroup className="provider-chip-group" label="Provider for this tab">
        {PROVIDER_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className="role-choice"
            {...radioProps(activeProvider === id)}
            disabled={busy}
            onClick={() => chooseProvider(id)}
          >
            {PROVIDERS[id].label}
          </button>
        ))}
      </RadioGroup>
    ) : null;

  // The Eagle-Eye chain this role begins (F2: the Analyst begins Eagle-Eye L).
  const eagleChain = eagleStartChain(roleId);
  const eagleToggle =
    showFields && activeTabSummary?.phase === "draft" && !activeTabSummary.chain && eagleChain ? (
      <label className="eagle-toggle">
        <input
          type="checkbox"
          checked={eagleOn}
          onChange={(event) => {
            eagleOnRef.current = event.target.checked;
            setEagleOn(event.target.checked);
          }}
        />
        {pipelineDef(eagleChain)?.name ?? eagleChain}
      </label>
    ) : null;
  // F3: with Eagle-Eye ticked, S / M / L picks the pipeline (by its first role).
  const sizeView = eagleToggle ? startSizeView(eagleChain, eagleOn, formValues, intakeTickets) : null;
  const sizePicker = sizeView ? (
    <SizePicker
      value={sizeView.value}
      suggestion={sizeView.suggestion}
      disabled={busy}
      onPick={(size) => {
        const next = roleForSize(size, roleId);
        if (next) chooseRole(next);
      }}
    />
  ) : null;

  // Start is always on screen. Until it can run it says why.
  const folderBlocked = folderNotice?.tone === "error";
  const startRoleId = pickedRoleId || (showFields ? roleId : "");
  const startRoleName = roles.find((item) => item.id === startRoleId)?.name ?? "";
  const startsTerminal = !!startRoleId && rememberedSurface(startRoleId) === "terminal";
  const startReason = launchChoice
    ? !displayedFolder
      ? CHOOSE_FOLDER_PROMPT
      : folderBlocked
        ? "The folder is not available."
        : null
    : !startRoleId
      ? "Choose a role"
      : !displayedFolder
        ? CHOOSE_FOLDER_PROMPT
        : folderBlocked
          ? "The folder is not available."
          : null;
  const startHint = startReason && !folderBlocked ? startReason : null;
  const startReasonId = "start-reason";
  const roleStartButton = (showFields || surface === "pick") && (
    <button
      type="button"
      className="primary-button"
      onClick={() => {
        if (startsTerminal) void startRoleTerminal();
        else void startSession(surface === "restore" && resendStartup);
      }}
      disabled={busy || !showFields || !!startReason || (activeProvider === "cursor" && !cliFound)}
      title={startReason ?? undefined}
      aria-describedby={startHint ? startReasonId : undefined}
    >
      {starting
        ? "Starting…"
        : startsTerminal && startRoleName
          ? `Start ${startRoleName} terminal`
          : "Start"}
    </button>
  );

  const previousAnswers = activeTabId ? previousAnswersRef.current[activeTabId] : undefined;
  const formHasText = Object.keys(formTextOf(values)).length > 0;
  const undoClear = clearedForm && clearedForm.tabId === activeTabId ? clearedForm : null;
  const formTools = showFields && (
    <div className="button-row form-tools" role="group" aria-label="Form tools">
      {surface === "restore" && newSessionOpen && previousAnswers && (
        <button
          type="button"
          className="link-button"
          onClick={fillPreviousValues}
          disabled={busy}
          title="Fill the fields with what this tab last started with"
        >
          Use the previous values
        </button>
      )}
      {undoClear ? (
        <span className="hint" role="status">
          Form cleared.{" "}
          <button type="button" className="link-button" onClick={undoClearForm} disabled={busy}>
            Undo
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="ghost-button"
          onClick={clearForm}
          disabled={busy || !formHasText}
          title="Empty the text fields. The folder stays."
        >
          Clear form
        </button>
      )}
    </div>
  );

  const idleActions = showFields && (
    <>
      {formTools}
      {surface === "restore" && (
        <label className="field-label continue-option">
          <input
            type="checkbox"
            checked={resendStartup}
            onChange={(e) => {
              const checked = e.target.checked;
              setResendStartup(checked);
              const tabId = activeTabIdRef.current;
              if (tabId && draftsRef.current[tabId]) {
                draftsRef.current[tabId] = {
                  ...draftsRef.current[tabId],
                  resendStartup: checked,
                };
              }
            }}
            disabled={busy}
          />
          Re-send startup prompt (full restart with merged role template)
        </label>
      )}
      {preview?.merged && preview.merged.text && (
        <details className="preview-details">
          <summary>
            Merged prompt ({preview.merged.chars.toLocaleString()} chars)
          </summary>
          <pre className="mono-snippet">{preview.merged.text}</pre>
        </details>
      )}
    </>
  );

  return (
    <div
      className="empty-state"
      ref={emptyStateRef}
      key={activeTabId ?? "new"}
      onScroll={(event) => {
        if (ignoreScrollRef.current) return;
        const tabId = activeTabIdRef.current;
        if (tabId) scrollPositions.current[tabId] = event.currentTarget.scrollTop;
      }}
    >
      <div className="empty-state-card start-screen">
        {handoffBanner}
        {activeHandoff && !activeHandoff.planField && (
          <label className="field-label">
            From {roleDisplayName(activeHandoff.sourceRoleId, roles)}
            <textarea
              className="text-input prompt-area"
              rows={8}
              value={scratch.content}
              onChange={(event) => {
                if (activeTabId) scratch.setContent(activeTabId, event.target.value);
              }}
              disabled={busy}
            />
            <span className="hint">
              This role has no plan field. The text is in the scratch pad. Start does not
              send it. After the session is running, Transfer moves it into the input.
            </span>
          </label>
        )}
        <div
          className={`start-body${historyFolder && !launchChoice ? " start-body-with-history" : ""}`}
        >
          <div className="start-main start-session-card">
            <h2 className="start-session-title">{startTitle}</h2>
            <div className="start-row" role="group" aria-label="Start a session">
              <FolderPicker
                compact
                value={displayedFolder}
                unavailable={folderNotice?.tone === "error"}
                disabled={busy}
                onChange={(path) => setField("cwd", path)}
              />
              <span className="start-row-spacer" aria-hidden />
              {launchChoice ? (
                <>
                  {launchChoice !== "shell" && blankModelPicker}
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void startBlankTerminal(launchChoice)}
                    title={startReason ?? undefined}
                    aria-describedby={startHint ? startReasonId : undefined}
                    disabled={
                      busy ||
                      !!startReason ||
                      (launchChoice === "cursor-cli" && !cliFound) ||
                      (launchChoice === "claude-cli" && providers.claude?.status.found === false)
                    }
                  >
                    {launchChoice === "shell" ? "Start terminal" : `Start ${CLI_LABEL[launchChoice]}`}
                  </button>
                </>
              ) : (
                <>
                  {providerChip}
                  {blankModelPicker}
                  {eagleToggle}
                  {roleStartButton}
                </>
              )}
            </div>
            <WorkspaceLine folder={displayedFolder} />
            {sizePicker}
            {eagleToggle && eagleOn && rememberedSurface(roleId) === "terminal" && (
              <ClickUpIntake
                key={activeTabId ?? ""}
                draftRef={intakeDraftRef}
                onOpenIntegrations={openIntegrations}
                disabled={busy}
                onDraftChange={(draft) => setIntakeTickets(tickedTickets(draft).length)}
              />
            )}
            {startHint && (
              <p className="hint start-reason" id={startReasonId}>
                {startHint}
              </p>
            )}
            {folderNotice?.tone === "error" && <p className="error">{folderNotice.text}</p>}
            {activeTabSummary?.worktreeBranch && (
              <p className="hint">
                Worktree on branch <strong>{activeTabSummary.worktreeBranch}</strong>. Remove it
                from the command palette when you are done.
              </p>
            )}
            <RoleTiles
              roles={roles}
              pickedRoleId={pickedRoleId}
              launchChoice={launchChoice}
              busy={busy}
              onChooseRole={chooseRole}
              onLaunchShell={() => {
                setLaunchChoice("shell");
                setPickedRoleId(null);
              }}
              onLaunchCursorCli={() => {
                setLaunchChoice("cursor-cli");
                setPickedRoleId(null);
              }}
              onLaunchClaudeCli={() => {
                setLaunchChoice("claude-cli");
                setPickedRoleId(null);
              }}
            />
            {pickedRoleId && !launchChoice && (
              <div className="start-surface-choices">
                <span className="start-surface-label" aria-hidden>
                  Open as
                </span>
                <RadioGroup label="Open as" className="start-surface-group">
                  {(["terminal", "chat"] as const).map((choice) => {
                    const checked = rememberedSurface(pickedRoleId) === choice;
                    return (
                      <button
                        key={choice}
                        type="button"
                        className="role-choice"
                        {...radioProps(checked)}
                        onClick={() => rememberSurface(pickedRoleId, choice)}
                        disabled={busy}
                        title={
                          choice === "chat"
                            ? "Open as chat. Autopilot needs Terminal."
                            : "Open as terminal (agent CLI in a terminal)"
                        }
                      >
                        {choice === "chat" ? (
                          <>
                            Chat{" "}
                            <span className="surface-hint" aria-hidden>
                              Autopilot needs Terminal
                            </span>
                          </>
                        ) : (
                          <>
                            <span aria-hidden>›_</span>&nbsp;Terminal
                          </>
                        )}
                      </button>
                    );
                  })}
                </RadioGroup>
              </div>
            )}
            {!launchChoice && (
              <>
                {restoreActions}
                {composerFields}
                {previewButton}
                {idleActions}
              </>
            )}
            {cliLaunchNote && <p className="hint">{cliLaunchNote}</p>}
            {terminalError && <p className="error">{terminalError}</p>}
            {transcriptSaveError && (
              <p className="error">Could not save the transcript: {transcriptSaveError}</p>
            )}
            {activeProvider === "cursor" && !cliFound && (
              <p className="error">Cursor CLI was not found.</p>
            )}
          </div>
          {historyFolder && !launchChoice && (
            <aside className="start-history">
              <RadioGroup className="history-provider-toggle" label="History provider">
                {(["claude", "cursor"] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="role-choice"
                    {...radioProps(historyProvider === id)}
                    onClick={() => setHistoryOverride(id)}
                  >
                    {PROVIDERS[id].label}
                  </button>
                ))}
              </RadioGroup>
              <CursorHistoryList
                entries={historyEntries}
                error={historyError}
                loading={historyLoading}
                busy={busy}
                title={PROVIDERS[historyProvider].historyTitle}
                readFrom={historyProvider === "claude" ? historyReadFrom : null}
                onResume={(entry) => void resumeHistoryEntry(entry)}
                onOpenCli={(entry) => void openCursorCli(entry.id, entry.cwd, entry.source)}
              />
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
