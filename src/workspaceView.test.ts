import { describe, expect, it } from "vitest";
import {
  appRoute,
  canContinueStoredSession,
  folderToWrite,
  mergeTabDraft,
  rememberScroll,
  rolePermissionSummary,
  scrollForTab,
  showStartupFields,
  switchTabForm,
  tabFormFromRecord,
  tabSurface,
  toggleSettings,
} from "./workspaceView";

describe("workspace routing", () => {
  it("opens on the workspace and toggles settings", () => {
    expect(appRoute(false)).toBe("workspace");
    expect(appRoute(true)).toBe("settings");
    expect(toggleSettings(false)).toBe(true);
    expect(toggleSettings(true)).toBe(false);
  });

  it("keeps a blank tab on the role and folder picker", () => {
    expect(
      tabSurface({
        sessionActive: false,
        hasSavedHistory: false,
        roleChosen: false,
        folder: "",
      }),
    ).toBe("pick");
    expect(
      tabSurface({
        sessionActive: false,
        hasSavedHistory: false,
        roleChosen: true,
        folder: "",
      }),
    ).toBe("pick");
    expect(
      tabSurface({
        sessionActive: false,
        hasSavedHistory: false,
        roleChosen: false,
        folder: "C:\\Repos\\Demo",
      }),
    ).toBe("pick");
  });

  it("reveals the startup fields after a role and a folder are chosen", () => {
    expect(
      tabSurface({
        sessionActive: false,
        hasSavedHistory: false,
        roleChosen: true,
        folder: "C:\\Repos\\Demo",
      }),
    ).toBe("compose");
  });

  it("shows saved history inside the tab, not as a separate landing page", () => {
    expect(
      tabSurface({
        sessionActive: false,
        hasSavedHistory: true,
        roleChosen: true,
        folder: "C:\\Repos\\Demo",
      }),
    ).toBe("restore");
  });

  it("fills the tab with the session once it is running", () => {
    expect(
      tabSurface({
        sessionActive: true,
        hasSavedHistory: true,
        roleChosen: true,
        folder: "C:\\Repos\\Demo",
      }),
    ).toBe("session");
  });
});

describe("per-tab form state", () => {
  const planner = tabFormFromRecord({
    roleId: "role_planner",
    cwd: "C:\\Users\\user\\Documents\\Projects\\personal-hub",
    answers: { title: "Plan the hub", cwd: "ignored-when-tab-cwd-is-set" },
    transcript: "planner transcript",
  });
  const implementer = tabFormFromRecord({
    roleId: "role_implementer",
    cwd: "C:\\Repos\\DCTerminal",
    answers: { title: "Build it" },
    transcript: "implementer transcript",
  });

  it("keeps role, folder, and fields isolated across tab switches", () => {
    let forms: Record<string, typeof planner> = {};
    let step = switchTabForm(forms, null, null, "tab_planner", planner);
    forms = step.forms;
    const edited = {
      ...forms.tab_planner,
      values: { ...forms.tab_planner.values, title: "Plan edited" },
    };
    forms = { ...forms, tab_planner: edited };
    step = switchTabForm(forms, "tab_planner", edited, "tab_implementer", implementer);
    expect(step.active.roleId).toBe("role_implementer");
    expect(step.active.values.cwd).toBe("C:\\Repos\\DCTerminal");
    expect(step.active.values.title).toBe("Build it");
    expect(step.active.pickedRoleId).toBe("role_implementer");
    step = switchTabForm(
      step.forms,
      "tab_implementer",
      step.active,
      "tab_planner",
      planner,
    );
    expect(step.active.roleId).toBe("role_planner");
    expect(step.active.values.title).toBe("Plan edited");
    expect(step.active.values.cwd).toContain("personal-hub");
    expect(step.forms.tab_implementer.values.title).toBe("Build it");
    expect(step.forms.tab_implementer.values.cwd).toBe("C:\\Repos\\DCTerminal");
  });

  it("fills a blank tab cwd from the saved answers and does not drop a known folder", () => {
    const restored = tabFormFromRecord({
      roleId: "role_planner",
      cwd: "",
      answers: {
        cwd: "C:\\Users\\user\\Documents\\Projects\\personal-hub",
        title: "Hub",
      },
      transcript: "saved",
    });
    expect(restored.values.cwd).toContain("personal-hub");
    expect(restored.pickedRoleId).toBe("role_planner");
    expect(restored.newSessionOpen).toBe(false);
    const merged = mergeTabDraft(
      { ...restored, values: { ...restored.values, cwd: "" } },
      restored,
    );
    expect(merged.values.cwd).toContain("personal-hub");
    expect(folderToWrite("C:\\Repos\\Planner", "")).toBe("C:\\Repos\\Planner");
    expect(folderToWrite("C:\\Repos\\Planner", "C:\\Other")).toBe("C:\\Other");
    expect(folderToWrite("", "")).toBe("");
  });

  it("restores each tab's scroll position", () => {
    expect(scrollForTab({}, "tab_planner")).toBe(0);
    const positions = rememberScroll(rememberScroll({}, "tab_planner", 240), "tab_implementer", 12);
    expect(scrollForTab(positions, "tab_planner")).toBe(240);
    expect(scrollForTab(positions, "tab_implementer")).toBe(12);
  });

  it("continues only a stored session, not a tab that never started", () => {
    expect(canContinueStoredSession(null)).toBe(false);
    expect(
      canContinueStoredSession({ phase: "awaitingInput", acpSessionId: null }),
    ).toBe(false);
    expect(
      canContinueStoredSession({ phase: "draft", acpSessionId: "session-1" }),
    ).toBe(false);
    expect(
      canContinueStoredSession({ phase: "awaitingInput", acpSessionId: "session-1" }),
    ).toBe(true);
  });

  it("keeps restored startup fields collapsed until a new session is chosen", () => {
    expect(showStartupFields({ surface: "pick", newSessionOpen: false })).toBe(false);
    expect(showStartupFields({ surface: "compose", newSessionOpen: false })).toBe(true);
    expect(showStartupFields({ surface: "restore", newSessionOpen: false })).toBe(false);
    expect(showStartupFields({ surface: "restore", newSessionOpen: true })).toBe(true);
  });
});

describe("role permission summaries", () => {
  it("describes the locked policy for each built-in role", () => {
    expect(rolePermissionSummary("role_implementer")).toContain("Auto-allow");
    expect(rolePermissionSummary("role_developer")).toContain("Auto-allow");
    expect(rolePermissionSummary("role_pr_reviewer")).toContain("Deny file writes");
    expect(rolePermissionSummary("role_planner")).toContain("Deny write and shell");
    expect(rolePermissionSummary("role_general")).toContain("Deny write and shell");
    expect(rolePermissionSummary("role_recommendation")).toContain("Deny write and shell");
    expect(rolePermissionSummary("role_codebase_audit")).toContain("Deny file writes");
  });

  it("does not infer policy from substrings in custom role ids", () => {
    expect(rolePermissionSummary("role_my_audit_helper")).toBe(
      "Ask for every permission.",
    );
  });
});
