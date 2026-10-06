// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  respondPermissionRequest: vi.fn(),
  respondPlanRequest: vi.fn(),
  reopenClosedTab: vi.fn(),
  historySearch: vi.fn(async () => []),
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
  newDraftTab: vi.fn(),
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
  listModels: vi.fn(async () => ({
    models: [{ id: "composer-2.5", label: "Composer 2.5", fast: false }],
    source: "fallback",
    fetchedAtMs: null,
    error: null,
  })),
  setTabModel: vi.fn(async () => "composer-2.5"),
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
  reopenClosedTab,
  transcriptLoad,
  worktreeTabCheck,
  worktreeTabNew,
  worktreeTabRemove,
  getLayout,
  getRole,
  setLayout,
  listCursorCliHistory,
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
