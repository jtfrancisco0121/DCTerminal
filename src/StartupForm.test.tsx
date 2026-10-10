// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./components/TerminalView", () => ({
  TerminalView: () => null,
  destroyTerminal: () => {},
  readTerminalHandoff: () => ({ selection: "", tail: "" }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class Channel {},
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const captured = vi.hoisted(() => ({
  permission: null as null | ((evt: unknown) => void),
  finished: null as null | ((evt: unknown) => void),
}));

vi.mock("./notify/systemNotify", () => ({ showSystemNotification: vi.fn(async () => true) }));

vi.mock("./bridge", () => {
  const listen = vi.fn(async () => () => {});
  return {
  closeTab: vi.fn(),
  devSessionCancel: vi.fn(),
  devSessionSend: vi.fn(),
  devSessionStop: vi.fn(),
  diagnosticsSetCapture: vi.fn(),
  diagnosticsStatus: vi.fn(async () => ({
    capturePermissionPayloads: false,
    appDataDir: "",
    transcriptsDir: "",
    logPath: "",
    lastError: null,
  })),
  diagnosticsReadLog: vi.fn(async () => ({ text: "", path: "" })),
  sessionAgentLogs: vi.fn(async () => ({ stderr: "" })),
  createPipelineTabs: vi.fn(async () => ({ tabs: [], closedTabs: [], activeTabId: null })),
  cursorApprovalMode: vi.fn(async () => ({
    kind: "allowlist",
    approvalMode: "allowlist",
    configPath: null,
    roleRulesOff: false,
    note: null,
  })),
  listenPermissionAuto: listen,
  listenPermissionRequests: vi.fn(async (handler: (evt: unknown) => void) => {
    captured.permission = handler;
    return () => {};
  }),
  listenPlanRequests: listen,
  listenQuestionRequests: listen,
  respondPermissionRequest: vi.fn(),
  respondPlanRequest: vi.fn(),
  respondQuestionRequest: vi.fn(),
  exportTextFile: vi.fn(),
  reopenClosedTab: vi.fn(),
  historySearch: vi.fn(async () => []),
  promptLibraryGet: vi.fn(async () => ({ prompts: [], recent: [], path: "" })),
  promptSave: vi.fn(),
  promptDelete: vi.fn(),
  promptMarkUsed: vi.fn(async () => ({ prompts: [], recent: [], path: "" })),
  promptRecordSend: vi.fn(async () => {}),
  promptClearRecent: vi.fn(),
  workspacesList: vi.fn(async () => ({ workspaces: [], path: "" })),
  detectCli: vi.fn(),
  cliLoginStatus: vi.fn(async () => ({ state: "loggedIn", account: null, detail: null, apiKeyEnv: false })),
  firstRunStatus: vi.fn(async () => ({ needed: false, completed: true })),
  firstRunComplete: vi.fn(async () => {}),
  workspaceSave: vi.fn(),
  workspaceDelete: vi.fn(),
  workspaceOpen: vi.fn(),
  transcriptLoad: vi.fn(async () => ({
    text: "",
    cwd: "",
    readOnly: true,
    recoveredFromCorrupt: false,
  })),
  setTabColor: vi.fn(),
  setTabLabel: vi.fn(async () => {}),
  transcriptSave: vi.fn(),
  getAppState: vi.fn(),
  getTab: vi.fn(),
  getFormRecall: vi.fn(async () => ({ cwd: "", values: {} })),
  getRole: vi.fn(),
  listenPromptFinished: vi.fn(async (handler: (evt: unknown) => void) => {
    captured.finished = handler;
    return () => {};
  }),
  listenSessionUpdates: listen,
  listCursorCliHistory: vi.fn(),
  listClaudeHistory: vi.fn(async () => ({
    entries: [],
    configDir: "/tmp/claude",
    configDisplay: "~/.claude",
    exists: true,
  })),
  getClaudeUsage: vi.fn(async () => ({ configDir: "/tmp/claude", windows: [], contextByTab: {} })),
  ackProviderNotice: vi.fn(async () => {}),
  setTabChain: vi.fn(async () => {}),
  startEagleEye: vi.fn(async () => ({ tab: { id: "ee" } })),
  newDraftTab: vi.fn(),
  openAccountWindow: vi.fn(async () => "win-2"),
  listenNewWindow: vi.fn(async () => () => {}),
  roleSessionStart: vi.fn(),
  saveFormDraft: vi.fn(async () => {}),
  selectActiveTab: vi.fn(),
  syncActiveTabForm: vi.fn(async () => {}),
  getTerminalSettings: vi.fn(async () => ({
    shell: "",
    fontSize: 14,
    roleSurface: {},
    roleRunMode: {},
  })),
  handoffBindTab: vi.fn(),
  handoffGet: vi.fn(),
  handoffList: vi.fn(async () => []),
  handoffSave: vi.fn(),
  ptyWrite: vi.fn(),
  roleTerminalStart: vi.fn(),
  scratchSave: vi.fn(async () => {}),
  scratchLoad: vi.fn(async () => ({ pads: [] })),
  setTerminalSettings: vi.fn(),
  DEFAULT_UI_SETTINGS: { theme: "github-dark", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false },
  getUiSettings: vi.fn(async () => ({ theme: "github-dark", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false })),
  setUiSettings: vi.fn(async (ui: unknown) => ui),
  getNotificationSettings: vi.fn(async () => ({
    enabled: true,
    system: true,
    toastWhenFocused: true,
  })),
  setNotificationSettings: vi.fn(async (value: unknown) => value),
  gitRepoInfo: vi.fn(),
  worktreeTabNew: vi.fn(),
  worktreeTabCheck: vi.fn(),
  worktreeTabRemove: vi.fn(async () => {}),
  changesList: vi.fn(async () => ({ state: "noRepo", files: [] })),
  changesSnapshot: vi.fn(),
  changesFileDiff: vi.fn(),
  changesRevert: vi.fn(),
  shellTerminalStart: vi.fn(),
  createPtyChannel: vi.fn(() => ({ onmessage: null })),
  terminalPlanFile: vi.fn(),
  validateAndPreview: vi.fn(),
  projectsList: vi.fn(async () => ({ favorites: [], recent: [] })),
  projectsRemove: vi.fn(),
  projectsToggleFavorite: vi.fn(),
  checkWorkingFolder: vi.fn(),
  acpSetModel: vi.fn(),
  getLayout: vi.fn(async () => ({
    splitMode: "single",
    secondaryTabId: null,
    primarySize: 50,
    filePanelOpen: false,
    filePanelWidth: 280,
  })),
  setLayout: vi.fn(async (layout: unknown) => layout),
  getModelSettings: vi.fn(async () => ({ defaultModel: "composer-2.5", roleModels: {} })),
  setModelSettings: vi.fn(async (models: unknown) => models),
  listModels: vi.fn(async (provider?: string) =>
    provider === "claude"
      ? {
          models: [
            { id: "default", label: "Default (account default)", fast: false },
            { id: "opus", label: "Opus", fast: false },
            { id: "sonnet", label: "Sonnet", fast: false },
            { id: "haiku", label: "Haiku", fast: true },
          ],
          source: "fallback",
          fetchedAtMs: null,
          error: null,
        }
      : {
          models: [{ id: "composer-2.5", label: "Composer 2.5", fast: false }],
          source: "fallback",
          fetchedAtMs: null,
          error: null,
        },
  ),
  setTabModel: vi.fn(async () => "composer-2.5"),
  getProviderSettings: vi.fn(async () => ({
    settings: { default: "claude", roleProvider: {}, claude: {}, cursor: {} },
    claudeConfigDir: {
      path: "/Users/jt/.claude-account2",
      display: "~/.claude-account2",
      source: "setting",
      exists: true,
    },
    claudeConfigDirEnv: null,
  })),
  setProviderSettings: vi.fn(),
  providerStatus: vi.fn(async (id: string) => ({
    status: {
      id,
      found: true,
      path: id === "claude" ? "/opt/homebrew/bin/claude" : "agent",
      version: "test",
      adapterFound: false,
      adapterPath: null,
      error: null,
    },
    login: {
      state: "loggedIn",
      account: id === "claude" ? "jt@example.com" : null,
      detail: null,
      apiKeyEnv: false,
    },
    configDir:
      id === "claude"
        ? {
            path: "/Users/jt/.claude-account2",
            display: "~/.claude-account2",
            source: "setting",
            exists: true,
          }
        : null,
    adapterInstall: null,
  })),
  setTabProvider: vi.fn(async () => {}),
  ptyKill: vi.fn(async () => {}),
  filesList: vi.fn(),
  filesRead: vi.fn(),
  filesWrite: vi.fn(),
  filesReveal: vi.fn(),
  };
});

import {
  changesFileDiff,
  changesList,
  changesRevert,
  filesList,
  filesRead,
  closeTab,
  getAppState,
  gitRepoInfo,
  historySearch,
  promptLibraryGet,
  promptMarkUsed,
  devSessionSend,
  promptRecordSend,
  promptSave,
  reopenClosedTab,
  transcriptLoad,
  workspaceOpen,
  workspaceSave,
  workspacesList,
  checkWorkingFolder,
  setTerminalSettings,
  setUiSettings,
  cliLoginStatus,
  firstRunComplete,
  firstRunStatus,
  newDraftTab,
  roleSessionStart,
  worktreeTabCheck,
  worktreeTabNew,
  worktreeTabRemove,
  getLayout,
  getRole,
  setLayout,
  listCursorCliHistory,
  listModels,
  setTabModel,
  setTabProvider,
  shellTerminalStart,
  selectActiveTab,
  setTabLabel,
  syncActiveTabForm,
} from "./bridge";
import { StartupForm } from "./StartupForm";

const developer = {
  id: "role_developer",
  name: "Developer",
  templateText: "# SENIOR SOFTWARE ENGINEER — CODEBASE ONBOARDING",
  templateVersion: 1,
  templateHash: "x",
  schemaTemplateHash: "x",
  defaultMode: "agent",
  injection: "send_on_start",
  color: "#3fb950",
  isBuiltIn: true,
  fields: [],
};

const tab = {
  id: "tab_dev",
  label: "Developer · Feature",
  roleId: "role_developer",
  roleSnapshot: { name: "Developer", templateVersion: 1, mode: "agent", injection: "send_on_start" },
  cwd: "C:\\Users\\user\\Documents\\Projects\\Encryptor",
  answers: {
    cwd: "C:\\Users\\user\\Documents\\Projects\\Encryptor",
    taskType: "Feature",
  },
  mergedPrompt: "",
  mergedPromptHash: "",
  phase: "draft",
  order: 1,
  createdAt: "2026-10-06T05:00:00Z",
  startupPromptSent: false,
  kind: "role",
  terminalLaunch: "",
  transcript: "",
};

describe("blank tab card", () => {
  beforeEach(() => {
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_dev",
      tabs: [
        {
          id: "tab_dev",
          label: "Developer · Feature",
          roleId: "role_developer",
          cwd: tab.cwd,
          phase: "draft",
          mergedPromptChars: 0,
          startupPromptSent: false,
          hasTranscript: false,
          folderStatus: "ok",
          color: "#3fb950",
          kind: "role",
          terminalLaunch: "",
          acpSessionId: null,
        },
      ],
      closedTabs: [],
    });
    vi.mocked(selectActiveTab).mockResolvedValue({ tab });
    vi.mocked(getRole).mockImplementation(async (id: string) => {
      if (id === "role_developer") return developer;
      return { ...developer, id, name: "Implementer", fields: [] };
    });
    vi.mocked(listCursorCliHistory).mockResolvedValue([
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        source: "acp",
        cwd: tab.cwd,
        title: "Senior Software Engineer",
        updatedAt: "2026-10-06T05:29:04.681517200+00:00",
      },
    ]);
    vi.mocked(syncActiveTabForm).mockClear();
    vi.mocked(setTerminalSettings).mockImplementation(async (value) => value as never);
  });

  it("shows the first-use tip once and can turn on the shortcut bar (U7)", async () => {
    vi.mocked(setUiSettings).mockClear();
    render(
      <StartupForm
        roles={[
          { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
        ]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    const tip = await screen.findByRole("status", { name: "Tip" });
    expect(screen.queryByRole("group", { name: "Shortcut bar" })).toBeNull();
    fireEvent.click(within(tip).getByRole("button", { name: "Show shortcut bar" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Tip" })).toBeNull());
    const bar = await screen.findByRole("group", { name: "Shortcut bar" });
    expect(within(bar).getByRole("button", { name: /Commands/ })).toBeTruthy();
    await waitFor(() =>
      expect(setUiSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ shortcutBar: true, tipsSeen: ["welcome"] }),
      ),
    );
  });

  it("keeps folder, model, and Start on one row without a top role navbar (U5)", async () => {
    render(
      <StartupForm
        roles={[
          { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
          { id: "role_planner", name: "Planner", defaultMode: "agent", color: "#58a6ff", fieldCount: 0 },
        ]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    await screen.findByLabelText("Title");
    const row = screen.getByRole("group", { name: "Start a session" });
    expect(within(row).queryByRole("group", { name: "Role" })).toBeNull();
    expect(row.querySelector(".folder-picker-compact")).toBeTruthy();
    expect(
      row.querySelector(`.folder-picker-chosen[title="${tab.cwd.replace(/\\/g, "\\\\")}"]`),
    ).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Start" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Validate & preview" })).toBeNull();
    const roles = screen.getByRole("group", { name: "Role" });
    expect(row.contains(roles)).toBe(false);
    expect(within(roles).getByRole("button", { name: "Developer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Validate & preview" })).toBeTruthy();
    const history = await screen.findByRole("region", { name: "Cursor CLI history" });
    expect(history.closest(".start-history")).toBeTruthy();
    expect(row.contains(history)).toBe(false);
    expect(row.contains(screen.getByLabelText("Title"))).toBe(false);
  });

  it("updates the draft when a role tile is selected", async () => {
    render(
      <StartupForm
        roles={[
          { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
          { id: "role_planner", name: "Planner", defaultMode: "agent", color: "#58a6ff", fieldCount: 0 },
        ]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    await screen.findByLabelText("Title");
    vi.mocked(syncActiveTabForm).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Planner" }));
    await waitFor(() => expect(syncActiveTabForm).toHaveBeenCalled());
    const calls = vi.mocked(syncActiveTabForm).mock.calls;
    const last = calls[calls.length - 1];
    expect(last?.[1]).toBe("role_planner");
  });

  it("remembers Chat vs Terminal per role from the start card", async () => {
    vi.mocked(setTerminalSettings).mockClear();
    render(
      <StartupForm
        roles={[
          { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
        ]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    await screen.findByLabelText("Title");
    const openAs = screen.getByRole("group", { name: "Open as" });
    fireEvent.click(within(openAs).getByRole("button", { name: "Terminal" }));
    await waitFor(() =>
      expect(setTerminalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          roleSurface: expect.objectContaining({ role_developer: "terminal" }),
        }),
      ),
    );
    fireEvent.click(within(openAs).getByRole("button", { name: "Chat" }));
    await waitFor(() =>
      expect(setTerminalSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          roleSurface: expect.objectContaining({ role_developer: "chat" }),
        }),
      ),
    );
  });

  it("still starts a role session from the start row", async () => {
    vi.mocked(roleSessionStart).mockReset();
    vi.mocked(roleSessionStart).mockResolvedValue({
      errors: [{ key: "_session", message: "test stop" }],
      session: null,
      tabId: "tab_dev",
    } as never);
    render(
      <StartupForm
        roles={[
          { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
        ]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    await screen.findByLabelText("Title");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(roleSessionStart).toHaveBeenCalledWith(
        "role_developer",
        expect.objectContaining({ cwd: tab.cwd }),
        "tab_dev",
        false,
        null,
      ),
    );
  });

  it("empties the chat scratch pad after a send or a transfer, and restores it when a send fails", async () => {
    vi.mocked(roleSessionStart).mockReset();
    vi.mocked(roleSessionStart).mockResolvedValue({
      errors: [],
      session: { sessionId: "sess_pad", modeId: "agent", cwd: tab.cwd },
      mergedChars: 10,
      injectionStrategy: "send_on_start",
      startupInjected: true,
      injectionInFlight: false,
      tabId: "tab_dev",
      resumedSession: false,
      skippedStartupInjection: false,
      folderWarning: null,
      loadedViaSessionLoad: false,
      replayMessageCount: 0,
      replayTruncated: false,
      replay: [],
    } as never);
    vi.mocked(devSessionSend).mockReset();
    vi.mocked(devSessionSend).mockResolvedValue({ dispatched: true } as never);
    vi.mocked(promptRecordSend).mockClear();
    render(
      <StartupForm
        roles={[
          { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
        ]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    await screen.findByLabelText("Title");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const pad = (await screen.findByLabelText("Scratch pad editor")) as HTMLTextAreaElement;
    const padBox = pad.closest(".scratch-pad") as HTMLElement;

    fireEvent.change(pad, { target: { value: "Explain the auth flow" } });
    fireEvent.click(within(padBox).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(devSessionSend).toHaveBeenCalledWith("Explain the auth flow", "tab_dev"));
    expect(promptRecordSend).toHaveBeenCalledWith("Explain the auth flow", "chat");
    await waitFor(() => expect(pad.value).toBe(""));

    // A send that never reaches the agent puts the text back.
    vi.mocked(devSessionSend).mockRejectedValueOnce(new Error("agent exited"));
    fireEvent.change(pad, { target: { value: "Try again" } });
    fireEvent.click(within(padBox).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(pad.value).toBe("Try again"));

    // Transfer moves the text into the input.
    fireEvent.click(within(padBox).getByRole("button", { name: "Transfer" }));
    await waitFor(() => expect(pad.value).toBe(""));
    expect((screen.getByRole("textbox", { name: "Follow-up message" }) as HTMLTextAreaElement).value).toBe(
      "Try again",
    );
  });

  it("resumes history from the side list", async () => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        source: "acp",
        cwd: tab.cwd,
        title: "Senior Software Engineer",
        updatedAt: "2026-10-06T05:29:04.681517200+00:00",
      },
    ]);
    vi.mocked(newDraftTab).mockResolvedValue({
      tab: {
        ...tab,
        id: "tab_resume",
        cwd: tab.cwd,
        answers: { cwd: tab.cwd },
      },
    });
    vi.mocked(roleSessionStart).mockReset();
    vi.mocked(roleSessionStart).mockResolvedValue({
      errors: [{ key: "_session", message: "test stop" }],
      session: null,
      tabId: "tab_resume",
    } as never);
    render(
      <StartupForm
        roles={[
          { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
        ]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    const history = await screen.findByRole("region", { name: "Cursor CLI history" });
    const resume = await within(history).findByRole("button", { name: "Resume" });
    fireEvent.click(resume);
    await waitFor(() => expect(newDraftTab).toHaveBeenCalled());
    await waitFor(() =>
      expect(roleSessionStart).toHaveBeenCalledWith(
        "role_developer",
        expect.anything(),
        "tab_resume",
        false,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ),
    );
  });

  it("shows Developer fields, a plain history line, and does not keep another role's task type", async () => {
    render(
      <StartupForm
        roles={[
          { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
        ]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );

    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(screen.getByLabelText("What to work on")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Validate & preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(screen.getByText("Saved sessions for this folder.")).toBeTruthy();
    expect(screen.queryByText(/session\/load/)).toBeNull();
    expect(screen.queryByText("Senior Software Engineer")).toBeNull();
    expect(screen.getAllByText("Developer").length).toBeGreaterThan(0);
    expect(screen.queryByText(/2026-10-06T05:29/)).toBeNull();

    await waitFor(() => {
      expect(syncActiveTabForm).toHaveBeenCalled();
    }, { timeout: 2000 });
    const calls = vi.mocked(syncActiveTabForm).mock.calls;
    const values = calls[calls.length - 1]?.[3];
    expect(values?.taskType).toBeUndefined();
    expect(values?.cwd).toContain("Encryptor");
  });
});

describe("terminal tab scratch pad", () => {
  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockImplementation(async (id: string) => {
      if (id === "role_developer") return developer;
      return { ...developer, id, name: "Implementer", fields: [] };
    });
  });

  it.each(["shell", "role", "cursor-cli"])(
    "renders the pad under a %s terminal and hides chat-only actions",
    async (launch) => {
      vi.mocked(getAppState).mockResolvedValue({
        activeTabId: "tab_term",
        tabs: [
          {
            id: "tab_term",
            label: "Developer · Koneksi (Terminal)",
            roleId: "role_developer",
            cwd: "/Users/jt/Koneksi",
            phase: "running",
            mergedPromptChars: 0,
            startupPromptSent: false,
            hasTranscript: false,
            folderStatus: "ok",
            color: "#3fb950",
            kind: "terminal",
            terminalLaunch: launch,
            acpSessionId: null,
          },
        ],
        closedTabs: [],
      });
      render(
        <StartupForm
          roles={[
            {
              id: "role_developer",
              name: "Developer",
              defaultMode: "agent",
              color: "#3fb950",
              fieldCount: 0,
            },
          ]}
          cli={{ found: true, path: "agent", version: "test", error: null }}
          cliError={null}
          cliFound
          showDevTools={false}
        />,
      );
      expect(await screen.findByRole("region", { name: "Scratch pad" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Paste to terminal" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Transfer" })).toBeNull();
      expect(screen.queryByRole("button", { name: "To terminal" })).toBeNull();
      expect(screen.queryByText(/---/)).toBeNull();
      const editor = screen.getByLabelText("Scratch pad editor");
      expect(editor.closest(".terminal-slot, .xterm")).toBeNull();
      expect(editor.closest(".terminal-screen")).toBeTruthy();
    },
  );
});

describe("live split view", () => {
  const terminalTab = (id: string, label: string, launch: string) => ({
    id,
    label,
    roleId: "role_developer",
    cwd: "/Users/jt/Koneksi",
    phase: "running",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: false,
    folderStatus: "ok",
    color: "#3fb950",
    kind: "terminal",
    terminalLaunch: launch,
    acpSessionId: null,
  });

  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockResolvedValue(developer);
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_a",
      tabs: [terminalTab("tab_a", "Main terminal", "role"), terminalTab("tab_b", "Other terminal", "shell")],
      closedTabs: [],
    });
  });

  it("restores the saved split, shows the other tab live, and closes it", async () => {
    vi.mocked(getLayout).mockResolvedValueOnce({
      splitMode: "horizontal",
      secondaryTabId: "tab_b",
      primarySize: 60,
      filePanelOpen: false,
      filePanelWidth: 280,
    });
    render(
      <StartupForm
        roles={[{ id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 }]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    const pane = await screen.findByLabelText("Second pane: Other terminal");
    expect(pane.getAttribute("data-pane")).toBe("secondary");
    // A role terminal shows its model; the default is composer-2.5.
    expect(await screen.findByRole("button", { name: "Model for Main terminal" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close split" }));
    await waitFor(() => expect(screen.queryByLabelText("Second pane: Other terminal")).toBeNull());
    await waitFor(
      () =>
        expect(vi.mocked(setLayout)).toHaveBeenLastCalledWith(
          expect.objectContaining({ splitMode: "single", secondaryTabId: null }),
        ),
      { timeout: 2000 },
    );
  });
});

describe("background tab notifications", () => {
  const terminalTab = (id: string, label: string) => ({
    id,
    label,
    roleId: "role_developer",
    cwd: "/Users/jt/Koneksi",
    phase: "running",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: false,
    folderStatus: "ok",
    color: "#3fb950",
    kind: "terminal",
    terminalLaunch: "shell",
    acpSessionId: null,
  });

  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockResolvedValue(developer);
    vi.mocked(selectActiveTab).mockResolvedValue({ tab: { ...tab, id: "tab_b", kind: "terminal" } });
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_a",
      tabs: [terminalTab("tab_a", "Main"), terminalTab("tab_b", "Reviewer · PR 12")],
      closedTabs: [],
    });
  });

  it("flags needs-you and the unseen dot on chips, clears them when viewed, and renames inline", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(
      <StartupForm
        roles={[{ id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 }]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    await screen.findByRole("region", { name: "Scratch pad" });
    await waitFor(() => expect(captured.finished).toBeTruthy());
    const chipOf = (name: RegExp) => screen.getByRole("tab", { name }).closest(".tab-chip")!;

    act(() => {
      captured.finished?.({
        tabId: "tab_b",
        sessionId: "s1",
        success: true,
        result: { stopReason: "end_turn", agentText: "All done.", updateCount: 1 },
        error: null,
        agentExited: false,
      });
    });
    await waitFor(() => expect(chipOf(/Reviewer · PR 12/).className).toContain("tab-chip-unseen"));
    expect(screen.getByRole("tab", { name: /Reviewer · PR 12/ }).textContent).toContain(
      "Finished, not viewed yet",
    );

    act(() => {
      captured.finished?.({
        tabId: "tab_b",
        sessionId: "s1",
        success: true,
        result: { stopReason: "end_turn", agentText: "Merge it now?", updateCount: 1 },
        error: null,
        agentExited: false,
      });
    });
    await waitFor(() => expect(chipOf(/Reviewer · PR 12/).className).toContain("tab-chip-needs"));

    // The visible tab never gets a mark.
    act(() => {
      captured.finished?.({
        tabId: "tab_a",
        sessionId: "s0",
        success: true,
        result: { stopReason: "end_turn", agentText: "ok", updateCount: 1 },
        error: null,
        agentExited: false,
      });
    });
    expect(chipOf(/^Main/).getAttribute("data-status")).toBe("idle");

    fireEvent.click(screen.getByRole("tab", { name: /Reviewer · PR 12/ }));
    await waitFor(() => expect(chipOf(/Reviewer · PR 12/).getAttribute("data-status")).toBe("idle"));

    fireEvent.doubleClick(screen.getByRole("tab", { name: /^Main/ }));
    const input = screen.getByLabelText("Rename Main");
    fireEvent.change(input, { target: { value: "Build fix" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(setTabLabel)).toHaveBeenCalledWith("tab_a", "Build fix"));
    focus.mockRestore();
  });

  it("toasts a background tab's permission request and finished turn, and opens it on click", async () => {
    render(
      <StartupForm
        roles={[{ id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 }]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    await screen.findByRole("region", { name: "Scratch pad" });
    await waitFor(() => expect(captured.permission).toBeTruthy());
    act(() => {
      captured.permission?.({
        tabId: "tab_b",
        sessionId: "s1",
        jsonRpcId: 7,
        title: "Run npm test",
        message: "",
        toolClass: "shell",
        displayKind: "shell",
        network: false,
        options: [],
        rawParams: "{}",
      });
    });
    const toast = await screen.findByRole("button", { name: /Reviewer · PR 12 needs permission/ });
    expect(toast.textContent).toContain("Run npm test");

    act(() => {
      captured.finished?.({
        tabId: "tab_b",
        sessionId: "s1",
        success: true,
        result: { stopReason: "end_turn", agentText: "Should I also update the docs?", updateCount: 2 },
        error: null,
        agentExited: false,
      });
    });
    const question = await screen.findByRole("button", { name: /Reviewer · PR 12 has a question/ });
    expect(screen.queryByRole("button", { name: /needs permission/ })).toBeNull();

    vi.mocked(selectActiveTab).mockClear();
    fireEvent.click(question);
    await waitFor(() => expect(vi.mocked(selectActiveTab)).toHaveBeenCalledWith("tab_b"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Reviewer · PR 12 has a question/ })).toBeNull(),
    );
  });
});

describe("worktree tabs", () => {
  const roles = [
    { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
  ];
  const worktreeRef = {
    repoRoot: "/Users/jt/Koneksi",
    path: "/Users/jt/Koneksi-worktrees/feat-login",
    branch: "feat/login",
  };
  const shellTab = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
    id,
    label,
    roleId: "role_developer",
    cwd: "/Users/jt/Koneksi",
    phase: "running",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: false,
    folderStatus: "ok",
    color: "#3fb950",
    kind: "terminal",
    terminalLaunch: "shell",
    acpSessionId: null,
    ...extra,
  });
  const worktreeTab = shellTab("tab_wt", "Koneksi · feat/login", {
    cwd: worktreeRef.path,
    worktreeBranch: "feat/login",
    worktreePath: worktreeRef.path,
  });
  const renderForm = () =>
    render(
      <StartupForm
        roles={roles}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
  const openPalette = () =>
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true, metaKey: true });

  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockResolvedValue(developer);
    vi.mocked(gitRepoInfo).mockReset();
    vi.mocked(worktreeTabNew).mockReset();
    vi.mocked(worktreeTabCheck).mockReset();
    vi.mocked(worktreeTabRemove).mockReset();
    vi.mocked(closeTab).mockReset();
  });

  it("never touches git until the user creates one, then opens the new tab", async () => {
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_a",
      tabs: [shellTab("tab_a", "Main")],
      closedTabs: [],
    });
    renderForm();
    await screen.findByRole("region", { name: "Scratch pad" });
    expect(gitRepoInfo).not.toHaveBeenCalled();
    expect(worktreeTabNew).not.toHaveBeenCalled();

    vi.mocked(gitRepoInfo).mockResolvedValue({
      mainRoot: "/Users/jt/Koneksi",
      currentBranch: "main",
      branches: ["main"],
      checkedOut: ["main"],
      worktreesDir: "/Users/jt/Koneksi-worktrees",
    });
    vi.mocked(worktreeTabNew).mockResolvedValue({
      tab: { ...tab, id: "tab_wt", kind: "role", cwd: worktreeRef.path, worktree: worktreeRef },
    });
    fireEvent.click(screen.getByRole("button", { name: "New tab in worktree…" }));
    const dialog = await screen.findByRole("dialog", { name: "New tab in worktree" });
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(gitRepoInfo).toHaveBeenCalledWith("/Users/jt/Koneksi"));
    expect(worktreeTabNew).not.toHaveBeenCalled();

    fireEvent.change(await screen.findByLabelText("New branch name"), {
      target: { value: "feat/login" },
    });
    expect(screen.getByText("/Users/jt/Koneksi-worktrees/feat-login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create worktree and open tab" }));
    await waitFor(() =>
      expect(worktreeTabNew).toHaveBeenCalledWith({
        repoPath: "/Users/jt/Koneksi",
        branch: "feat/login",
        createBranch: true,
        base: "main",
        roleId: "role_developer",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New tab in worktree" })).toBeNull(),
    );
    expect(await screen.findByText("Worktree created")).toBeTruthy();
  });

  it("shows the branch, refuses a dirty tree, and removes a clean one after confirming", async () => {
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_wt",
      tabs: [worktreeTab, shellTab("tab_a", "Main")],
      closedTabs: [],
    });
    renderForm();
    await screen.findByRole("region", { name: "Scratch pad" });
    expect(screen.getAllByLabelText("Git branch")[0].textContent).toContain("feat/login");
    expect(screen.getByRole("tab", { name: /Koneksi · feat\/login/ }).closest(".tab-chip")!.textContent)
      .toContain("⎇ feat/login");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(worktreeTabCheck).mockResolvedValue({
      worktree: worktreeRef,
      branch: "feat/login",
      dirty: [" M src/app.ts"],
    });
    openPalette();
    fireEvent.click(await screen.findByRole("button", { name: /Remove this tab's worktree/ }));
    expect(await screen.findByText("Worktree not removed")).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
    expect(worktreeTabRemove).not.toHaveBeenCalled();

    vi.mocked(worktreeTabCheck).mockResolvedValue({
      worktree: worktreeRef,
      branch: "feat/login",
      dirty: [],
    });
    vi.mocked(closeTab).mockResolvedValue({
      activeTabId: "tab_a",
      tabs: [shellTab("tab_a", "Main")],
      closedTabs: [],
    });
    confirm.mockReturnValueOnce(false);
    openPalette();
    fireEvent.click(await screen.findByRole("button", { name: /Remove this tab's worktree/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(closeTab).not.toHaveBeenCalled();
    expect(worktreeTabRemove).not.toHaveBeenCalled();

    openPalette();
    fireEvent.click(await screen.findByRole("button", { name: /Remove this tab's worktree/ }));
    await waitFor(() => expect(worktreeTabRemove).toHaveBeenCalledWith("tab_wt", true));
    expect(closeTab).toHaveBeenCalledWith("tab_wt");
    expect(vi.mocked(closeTab).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(worktreeTabRemove).mock.invocationCallOrder[0],
    );
    expect(await screen.findByText("Worktree removed")).toBeTruthy();
    confirm.mockRestore();
  });
});

describe("changes (diff) panel", () => {
  const terminalTab = {
    id: "tab_a",
    label: "Main",
    roleId: "role_developer",
    cwd: "/Users/jt/Koneksi",
    phase: "running",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: false,
    folderStatus: "ok",
    color: "#3fb950",
    kind: "terminal",
    terminalLaunch: "cursor-cli",
    acpSessionId: null,
  };
  const base = "a".repeat(40);
  const now = "b".repeat(40);
  const file = {
    path: "src/app.ts",
    cwdPath: "src/app.ts",
    status: "modified",
    oldBlob: "1".repeat(40),
    newBlob: "2".repeat(40),
    additions: 1,
    deletions: 1,
    binary: false,
  };

  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockResolvedValue(developer);
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_a",
      tabs: [terminalTab],
      closedTabs: [],
    });
    vi.mocked(changesList).mockResolvedValue({
      state: "ok",
      scope: "turn",
      repoRoot: "/Users/jt/Koneksi",
      baseTree: base,
      nowTree: now,
      baselineAt: "2026-10-06T10:00:00Z",
      files: [file],
    });
    vi.mocked(changesFileDiff).mockResolvedValue({
      path: "src/app.ts",
      binary: false,
      text: "@@ -1 +1 @@\n-old\n+new\n",
      truncated: false,
    });
    vi.mocked(filesList).mockImplementation(async (_tab: string, path = "") => ({
      root: "/Users/jt/Koneksi",
      path,
      truncated: false,
      entries:
        path === ""
          ? [{ name: "src", path: "src", isDir: true, size: 0 }]
          : [{ name: "app.ts", path: "src/app.ts", isDir: false, size: 3 }],
    }));
    vi.mocked(filesRead).mockResolvedValue({
      path: "src/app.ts",
      absPath: "/Users/jt/Koneksi/src/app.ts",
      size: 4,
      mtimeMs: 1,
      kind: "text",
      text: "new\n",
      dataBase64: null,
      mime: null,
    });
  });

  it("opens from the tab, never reverts on its own, and Open in file panel focuses the file", async () => {
    render(
      <StartupForm
        roles={[{ id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 }]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Changes/ }));
    const dialog = await screen.findByRole("dialog", { name: "Changes in Main" });
    expect(await screen.findByRole("table", { name: "Diff of src/app.ts" })).toBeTruthy();
    expect(dialog.textContent).toContain("src/app.ts");
    expect(changesRevert).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open in file panel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Changes in Main" })).toBeNull(),
    );
    const panel = await screen.findByRole("complementary", { name: "Files" });
    await waitFor(() => expect(vi.mocked(filesRead)).toHaveBeenCalledWith("tab_a", "src/app.ts"));
    await waitFor(() =>
      expect(panel.contains(document.activeElement)).toBe(true),
    );
    expect(changesRevert).not.toHaveBeenCalled();
  });
});

describe("search all chats", () => {
  const summary = (id: string, label: string) => ({
    id,
    label,
    roleId: "role_developer",
    cwd: tab.cwd,
    phase: "draft",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: id === "tab_old",
    folderStatus: "ok",
    color: "#3fb950",
    kind: "role",
    terminalLaunch: "",
    acpSessionId: null,
  });

  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockResolvedValue(developer);
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_dev",
      tabs: [summary("tab_dev", "Developer · Feature")],
      closedTabs: [
        { id: "tab_old", label: "Old chat", roleId: "role_developer", cwd: tab.cwd, color: "#3fb950" },
      ],
    });
    vi.mocked(selectActiveTab).mockResolvedValue({ tab });
  });

  it("finds saved history from the palette and reopens the closed tab at the hit", async () => {
    vi.mocked(historySearch).mockResolvedValue([
      {
        source: "closed",
        tabId: "tab_old",
        label: "Old chat",
        cwd: tab.cwd,
        updatedAt: "2026-10-05T00:00:00Z",
        occurrence: 1,
        totalInSource: 2,
        before: "then the ",
        matched: "login",
        after: " page broke",
      },
    ]);
    const transcript = "fixed login first; then the login page broke";
    vi.mocked(transcriptLoad).mockResolvedValue({
      text: transcript,
      cwd: tab.cwd,
      readOnly: true,
      recoveredFromCorrupt: false,
    });
    vi.mocked(reopenClosedTab).mockImplementation(async () => {
      vi.mocked(getAppState).mockResolvedValue({
        activeTabId: "tab_old",
        tabs: [summary("tab_dev", "Developer · Feature"), summary("tab_old", "Old chat")],
        closedTabs: [],
      });
      return { tab: { ...tab, id: "tab_old", label: "Old chat", transcript } };
    });
    render(
      <StartupForm
        roles={[{ id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 }]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
    await screen.findByLabelText("Title");
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true, metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: /Search all chats/ }));
    const dialog = await screen.findByRole("dialog", { name: "Search chats" });
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "login" },
    });
    await waitFor(() => expect(historySearch).toHaveBeenCalledWith("login"));
    fireEvent.click(await within(dialog).findByRole("option", { name: /Old chat/ }));

    await waitFor(() => expect(reopenClosedTab).toHaveBeenCalledWith("tab_old"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search chats" })).toBeNull(),
    );
    const current = await waitFor(() => {
      const mark = document.querySelector("mark.search-hit-current");
      expect(mark).toBeTruthy();
      return mark!;
    });
    expect(current.textContent).toBe("login");
    expect(document.querySelectorAll("mark.search-hit")).toHaveLength(2);
  });
});

describe("prompt library (F6)", () => {
  const appData = "/Users/jt/Library/Application Support/com.jtfrancisco.dcterminal/prompts.json";
  const saved = {
    id: "p_review",
    name: "Review diff",
    body: "Review the diff.",
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
    lastUsedAt: null,
  };

  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockResolvedValue(developer);
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_term",
      tabs: [
        {
          id: "tab_term",
          label: "Shell · Koneksi",
          roleId: "role_developer",
          cwd: "/Users/jt/Koneksi",
          phase: "running",
          mergedPromptChars: 0,
          startupPromptSent: false,
          hasTranscript: false,
          folderStatus: "ok",
          color: "#3fb950",
          kind: "terminal",
          terminalLaunch: "shell",
          acpSessionId: null,
        },
      ],
      closedTabs: [],
    });
    vi.mocked(promptLibraryGet).mockResolvedValue({ prompts: [saved], recent: [], path: appData });
    vi.mocked(promptRecordSend).mockClear();
    vi.mocked(promptMarkUsed).mockClear();
  });

  const renderForm = () =>
    render(
      <StartupForm
        roles={[{ id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 }]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );

  it("inserts a saved prompt into the pad and records terminal sends", async () => {
    renderForm();
    await screen.findByRole("region", { name: "Scratch pad" });
    const editor = screen.getByLabelText("Scratch pad editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "draft notes" } });

    fireEvent.click(screen.getByRole("button", { name: "Prompts" }));
    const dialog = await screen.findByRole("dialog", { name: "Prompt library" });
    await waitFor(() => expect(dialog.textContent).toContain(appData));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Insert into scratch pad" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Prompt library" })).toBeNull(),
    );
    await waitFor(() => expect(editor.value).toBe("draft notes\n\nReview the diff."));
    expect(promptMarkUsed).toHaveBeenCalledWith("p_review");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(promptRecordSend).toHaveBeenCalledWith("draft notes\n\nReview the diff.", "terminal"),
    );
    // Sent text leaves the pad; Recent sends keeps it.
    await waitFor(() => expect(editor.value).toBe(""));
  });

  it("saves the scratch pad as a named prompt from the palette", async () => {
    vi.mocked(promptSave).mockResolvedValue({
      prompts: [saved, { ...saved, id: "p_new", name: "Run checks", body: "npm run check" }],
      recent: [],
      path: appData,
    });
    renderForm();
    await screen.findByRole("region", { name: "Scratch pad" });
    fireEvent.change(screen.getByLabelText("Scratch pad editor"), {
      target: { value: "npm run check" },
    });
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true, metaKey: true });
    fireEvent.click(await screen.findByRole("button", { name: /Save scratch pad as prompt/ }));
    const name = (await screen.findByRole("textbox", { name: "Prompt name" })) as HTMLInputElement;
    expect((screen.getByRole("textbox", { name: "Prompt text" }) as HTMLTextAreaElement).value).toBe(
      "npm run check",
    );
    fireEvent.change(name, { target: { value: "Run checks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));
    await waitFor(() => expect(promptSave).toHaveBeenCalledWith(null, "Run checks", "npm run check"));
    expect(await screen.findByRole("option", { name: /Run checks/ })).toBeTruthy();
  });
});

describe("workspaces (F7)", () => {
  const wsPath = "/Users/jt/Library/Application Support/com.jtfrancisco.dcterminal/workspaces.json";
  const summary = (id: string, label: string, cwd: string, extra: Record<string, unknown> = {}) => ({
    id,
    label,
    roleId: "role_developer",
    cwd,
    phase: "draft",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: false,
    folderStatus: "ok",
    color: "#3fb950",
    kind: "role",
    terminalLaunch: "",
    acpSessionId: null,
    ...extra,
  });
  const saved = {
    id: "ws_daily",
    name: "Koneksi daily",
    savedAt: "2026-10-06T09:00:00Z",
    tabs: [
      {
        label: "Developer · Login fix",
        customLabel: true,
        roleId: "role_developer",
        roleSnapshot: { name: "Developer", templateVersion: 1, mode: "agent", injection: "send_on_start" },
        cwd: "/Users/jt/Koneksi",
        kind: "role",
        terminalLaunch: "",
        color: null,
        model: null,
        answers: {},
      },
    ],
    activeIndex: 0,
  };

  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockResolvedValue(developer);
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_dev",
      tabs: [summary("tab_dev", "Developer · Feature", tab.cwd)],
      closedTabs: [],
    });
    vi.mocked(selectActiveTab).mockResolvedValue({ tab });
    vi.mocked(workspacesList).mockResolvedValue({ workspaces: [saved], path: wsPath });
    vi.mocked(workspaceOpen).mockReset();
    vi.mocked(workspaceSave).mockReset();
    vi.mocked(syncActiveTabForm).mockClear();
  });

  const renderForm = () =>
    render(
      <StartupForm
        roles={[{ id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 }]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
  const openPalette = () =>
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true, metaKey: true });

  it("saves the open tabs as a named workspace from the palette", async () => {
    vi.mocked(workspaceSave).mockResolvedValue({
      workspaces: [{ ...saved, id: "ws_new", name: "Morning" }, saved],
      path: wsPath,
    });
    renderForm();
    await screen.findByLabelText("Title");
    openPalette();
    fireEvent.click(await screen.findByRole("button", { name: /Save tabs as workspace/ }));
    const dialog = await screen.findByRole("dialog", { name: "Workspaces" });
    await waitFor(() => expect(dialog.textContent).toContain(wsPath));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Morning" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save 1 tab/ }));
    await waitFor(() => expect(workspaceSave).toHaveBeenCalledWith("Morning", false));
    expect(syncActiveTabForm).toHaveBeenCalled();
    expect(await within(dialog).findByRole("option", { name: /Morning/ })).toBeTruthy();
  });

  it("opens a workspace and shows its restored tab title, folder, and role", async () => {
    const restored = summary("tab_ws1", "Developer · Login fix", "/Users/jt/Koneksi");
    vi.mocked(workspaceOpen).mockImplementation(async () => {
      const state = {
        activeTabId: "tab_ws1",
        tabs: [summary("tab_dev", "Developer · Feature", tab.cwd), restored],
        closedTabs: [],
      };
      vi.mocked(getAppState).mockResolvedValue(state);
      vi.mocked(selectActiveTab).mockResolvedValue({
        tab: {
          ...tab,
          id: "tab_ws1",
          label: "Developer · Login fix",
          cwd: "/Users/jt/Koneksi",
          answers: { cwd: "/Users/jt/Koneksi" },
        },
      });
      return { state, tabIds: ["tab_ws1"], skipped: [] };
    });
    renderForm();
    await screen.findByLabelText("Title");
    openPalette();
    fireEvent.click(await screen.findByRole("button", { name: /Open workspace/ }));
    const dialog = await screen.findByRole("dialog", { name: "Workspaces" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Open" }));
    await waitFor(() => expect(workspaceOpen).toHaveBeenCalledWith("ws_daily", false));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull());
    expect((await screen.findAllByText("Developer · Login fix")).length).toBeGreaterThan(0);
    await waitFor(() => expect(selectActiveTab).toHaveBeenCalledWith("tab_ws1"));
    await waitFor(() =>
      expect(document.querySelector('.folder-picker-chosen[title="/Users/jt/Koneksi"]')).toBeTruthy(),
    );
  });
});

describe("first-run setup (F8)", () => {
  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockResolvedValue(developer);
    vi.mocked(getAppState).mockResolvedValue({ activeTabId: null, tabs: [], closedTabs: [] });
    vi.mocked(newDraftTab).mockImplementation(async () => {
      vi.mocked(getAppState).mockResolvedValue({
        activeTabId: "tab_dev",
        tabs: [
          {
            id: "tab_dev",
            label: "New · Developer",
            roleId: "role_developer",
            cwd: "",
            phase: "draft",
            mergedPromptChars: 0,
            startupPromptSent: false,
            hasTranscript: false,
            folderStatus: "ok",
            color: "#3fb950",
            kind: "role",
            terminalLaunch: "",
            acpSessionId: null,
          },
        ],
        closedTabs: [],
      });
      return { tab: { ...tab, cwd: "", answers: { cwd: "" }, label: "New · Developer" } };
    });
    vi.mocked(cliLoginStatus).mockResolvedValue({
      state: "loggedOut",
      account: null,
      detail: null,
      apiKeyEnv: false,
    });
    vi.mocked(roleSessionStart).mockReset();
    vi.mocked(roleSessionStart).mockResolvedValue({
      errors: [{ key: "_session", message: "test stop" }],
      session: null,
      tabId: "tab_dev",
    } as never);
    vi.mocked(firstRunComplete).mockClear();
    vi.mocked(setTerminalSettings).mockImplementation(async (value) => value);
  });

  afterEach(() => {
    vi.mocked(firstRunStatus).mockResolvedValue({ needed: false, completed: true });
  });

  const renderFresh = () =>
    render(
      <StartupForm
        roles={[{ id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 }]}
        cli={{ found: true, path: "/usr/local/bin/agent", version: "2026.10.01", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );

  it("walks a fresh profile from Claude and Cursor checks to Start and starts the chosen role in the folder", async () => {
    vi.mocked(firstRunStatus).mockResolvedValue({ needed: true, completed: false });
    renderFresh();
    const dialog = await screen.findByRole("dialog", { name: "Set up DCTerminal" });
    // Claude first: the config folder and the account for it.
    expect(await within(dialog).findByText(/Signed in as jt@example\.com/)).toBeTruthy();
    expect(dialog.textContent).toContain("~/.claude-account2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    // Cursor CLI (optional).
    expect(dialog.textContent).toContain("/usr/local/bin/agent");
    expect(await within(dialog).findByText(/Not signed in/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    vi.mocked(checkWorkingFolder).mockResolvedValue("/Users/jt/Koneksi");
    fireEvent.click(within(dialog).getByRole("button", { name: "Recent" }));
    const pathInput = within(dialog).getByRole("textbox", { name: "Enter a folder path" });
    fireEvent.change(pathInput, { target: { value: "/Users/jt/Koneksi" } });
    fireEvent.submit(pathInput.closest("form")!);
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: /Developer/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Set up DCTerminal" })).toBeNull(),
    );
    expect(firstRunComplete).toHaveBeenCalled();
    await waitFor(() =>
      expect(roleSessionStart).toHaveBeenCalledWith(
        "role_developer",
        expect.objectContaining({ cwd: "/Users/jt/Koneksi" }),
        "tab_dev",
        false,
        null,
      ),
    );
  });

  it("waits for a role's required fields instead of starting", async () => {
    vi.mocked(firstRunStatus).mockResolvedValue({ needed: true, completed: false });
    vi.mocked(getRole).mockResolvedValue({
      ...developer,
      fields: [
        { key: "title", label: "Title", type: "text", required: true, remember: false },
      ],
    } as never);
    vi.mocked(checkWorkingFolder).mockResolvedValue("/Users/jt/Koneksi");
    renderFresh();
    const dialog = await screen.findByRole("dialog", { name: "Set up DCTerminal" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    await within(dialog).findByText(/Not signed in/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Recent" }));
    const pathInput = within(dialog).getByRole("textbox", { name: "Enter a folder path" });
    fireEvent.change(pathInput, { target: { value: "/Users/jt/Koneksi" } });
    fireEvent.submit(pathInput.closest("form")!);
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: /Developer/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(await screen.findByText(/Fill in Title, then press Start/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute("data-field-key")).toBe("title"));
    expect(roleSessionStart).not.toHaveBeenCalled();
  });

  it("does not appear for an existing profile, and Skip setup remembers the choice", async () => {
    vi.mocked(firstRunStatus).mockClear();
    renderFresh();
    await screen.findByRole("tab", { name: /New · Developer/ });
    await waitFor(() => expect(firstRunStatus).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Set up DCTerminal" })).toBeNull();
    cleanup();

    vi.mocked(firstRunStatus).mockResolvedValue({ needed: true, completed: false });
    renderFresh();
    const dialog = await screen.findByRole("dialog", { name: "Set up DCTerminal" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Skip setup" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Set up DCTerminal" })).toBeNull(),
    );
    expect(firstRunComplete).toHaveBeenCalled();
    expect(roleSessionStart).not.toHaveBeenCalled();
  });
});

describe("command palette (F9)", () => {
  const folder = "/Users/jt/Koneksi";
  const summary = (id: string, label: string) => ({
    id,
    label,
    roleId: "role_developer",
    cwd: folder,
    phase: "draft",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: false,
    folderStatus: "ok",
    color: "#3fb950",
    kind: "role",
    terminalLaunch: "",
    acpSessionId: null,
  });
  const historyEntry = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    source: "acp",
    cwd: folder,
    title: "Login",
    updatedAt: null,
    roleName: "Developer",
    userText: "Fix the login",
  };

  beforeEach(() => {
    vi.mocked(listCursorCliHistory).mockResolvedValue([]);
    vi.mocked(getRole).mockResolvedValue(developer);
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_dev",
      tabs: [summary("tab_dev", "Developer · Feature"), summary("tab_b", "Developer · Other")],
      closedTabs: [],
    });
    vi.mocked(selectActiveTab).mockResolvedValue({
      tab: { ...tab, cwd: folder, answers: { cwd: folder } },
    });
    vi.mocked(listModels).mockImplementation(async (provider?: string) =>
      provider === "claude"
        ? {
            models: [
              { id: "default", label: "Default (account default)", fast: false },
              { id: "opus", label: "Opus", fast: false },
              { id: "sonnet", label: "Sonnet", fast: false },
              { id: "haiku", label: "Haiku", fast: true },
            ],
            source: "fallback",
            fetchedAtMs: null,
            error: null,
          }
        : {
            models: [
              { id: "composer-2.5", label: "Composer 2.5", fast: false },
              { id: "gpt-5", label: "GPT-5", fast: false },
            ],
            source: "fallback",
            fetchedAtMs: null,
            error: null,
          },
    );
    vi.mocked(setTabModel).mockClear();
    vi.mocked(newDraftTab).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  const renderForm = () =>
    render(
      <StartupForm
        roles={[{ id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 }]}
        cli={{ found: true, path: "agent", version: "test", error: null }}
        cliError={null}
        cliFound
        showDevTools={false}
      />,
    );
  const openPalette = async () => {
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true, metaKey: true });
    return screen.findByRole("dialog", { name: "Command palette" });
  };

  it("lists hand-off, worktree, split, model, history, search, prompts, and workspaces", async () => {
    renderForm();
    await screen.findByLabelText("Title");
    const palette = await openPalette();
    for (const [title, group] of [
      ["Hand off plan…", "Hand-off"],
      ["New tab in worktree…", "Worktree"],
      ["Split right", "Split"],
      ["Change model…", "Model"],
      ["Chat history for this folder…", "History"],
      ["Search all chats…", "Search"],
      ["Prompt library…", "Prompts"],
      ["Open workspace…", "Workspaces"],
    ]) {
      const button = within(palette).getByRole("button", { name: new RegExp(`^${title}`) });
      expect(button.textContent).toContain(group);
    }
  });

  it("switches the tab's provider from the Start card chip and the model list follows", async () => {
    renderForm();
    await screen.findByLabelText("Title");
    const chips = await screen.findByRole("radiogroup", { name: "Provider for this tab" });
    expect(
      within(chips).getByRole("radio", { name: "Cursor" }).getAttribute("aria-checked"),
    ).toBe("true");
    // The status bar shows the provider of the active tab.
    expect(screen.getByTestId("status-provider").textContent).toBe("Cursor");
    vi.mocked(setTabProvider).mockClear();
    vi.mocked(getAppState).mockResolvedValue({
      activeTabId: "tab_dev",
      tabs: [
        { ...summary("tab_dev", "Developer · Feature"), provider: "claude" },
        summary("tab_b", "Developer · Other"),
      ],
      closedTabs: [],
    });
    fireEvent.click(within(chips).getByRole("radio", { name: "Claude" }));
    await waitFor(() =>
      expect(setTabProvider).toHaveBeenCalledWith("tab_dev", "claude", "role_developer"),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("radiogroup", { name: "Provider for this tab" }))
          .getByRole("radio", { name: "Claude" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(setTabModel).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("status-provider").textContent).toBe(
        "Claude · ~/.claude-account2 · jt@…",
      ),
    );
    expect(screen.getByTestId("status-provider").getAttribute("title")).toContain(
      "Config folder: /Users/jt/.claude-account2",
    );
    const tabChip = screen.getByRole("tab", { name: /Developer · Feature/ });
    expect(tabChip.getAttribute("title")).toContain(
      "Provider: Claude · /Users/jt/.claude-account2 · jt@example.com",
    );
    fireEvent.click(screen.getByRole("button", { name: "Model for this tab" }));
    const list = await screen.findByRole("listbox", { name: "Model for this tab" });
    expect(within(list).getByText("Opus")).toBeTruthy();
    expect(within(list).queryByText("GPT-5")).toBeNull();
  });

  it("starts the Claude Code tile as its own launch with the Claude model list", async () => {
    renderForm();
    await screen.findByLabelText("Title");
    vi.mocked(shellTerminalStart).mockReset();
    vi.mocked(shellTerminalStart).mockResolvedValue({
      errors: [{ key: "cwd", message: "stop here" }],
      tabId: null,
      pid: null,
      usedPromptFile: false,
    });
    const tiles = screen.getByRole("group", { name: "Role" });
    fireEvent.click(within(tiles).getByRole("button", { name: "Claude Code" }));
    expect(
      within(tiles).getByRole("button", { name: "Claude Code" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Model for this tab" }));
    const list = await screen.findByRole("listbox", { name: "Model for this tab" });
    expect(within(list).getByText("Opus")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start Claude Code" }));
    await waitFor(() =>
      expect(shellTerminalStart).toHaveBeenCalledWith(
        expect.objectContaining({ launch: "claude-cli", cwd: folder, tabId: "tab_dev" }),
      ),
    );
  });

  it("changes the active tab's model from the palette", async () => {
    renderForm();
    await screen.findByLabelText("Title");
    const palette = await openPalette();
    fireEvent.click(within(palette).getByRole("button", { name: /^Change model…/ }));
    const again = await screen.findByRole("dialog", { name: "Command palette" });
    expect((within(again).getByPlaceholderText("Type a command") as HTMLInputElement).value).toBe(
      "use model ",
    );
    fireEvent.click(await within(again).findByRole("button", { name: /Use model: GPT-5/ }));
    await waitFor(() => expect(setTabModel).toHaveBeenCalledWith("tab_dev", "gpt-5"));
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("opens the folder's chat history and resumes a chat in a new tab", async () => {
    renderForm();
    await screen.findByLabelText("Title");
    vi.mocked(listCursorCliHistory).mockResolvedValue([historyEntry]);
    vi.mocked(newDraftTab).mockRejectedValue(new Error("stop here"));
    const palette = await openPalette();
    fireEvent.click(within(palette).getByRole("button", { name: /^Chat history for this folder…/ }));
    const dialog = await screen.findByRole("dialog", { name: "Chat history" });
    expect(dialog.textContent).toContain(folder);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(newDraftTab).toHaveBeenCalledWith("role_developer", folder));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull());
  });

  it("splits with another tab, and explains hand-off when there is no plan", async () => {
    renderForm();
    await screen.findByLabelText("Title");
    let palette = await openPalette();
    fireEvent.click(within(palette).getByRole("button", { name: /^Split right/ }));
    expect(await screen.findByRole("dialog", { name: "Split right with tab" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Split right with tab" })).toBeNull(),
    );

    palette = await openPalette();
    fireEvent.click(within(palette).getByRole("button", { name: /^Hand off plan…/ }));
    expect(await screen.findByText(/Open a Planner or Plan Reviewer chat or terminal/)).toBeTruthy();
  });
});
