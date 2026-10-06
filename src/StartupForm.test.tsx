// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  setTabColor: vi.fn(),
  setTabLabel: vi.fn(),
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
  getAppState,
  getLayout,
  getRole,
  setLayout,
  listCursorCliHistory,
  selectActiveTab,
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
