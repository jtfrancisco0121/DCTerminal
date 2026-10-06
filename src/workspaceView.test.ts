import { describe, expect, it } from "vitest";
import {
  appRoute,
  rolePermissionSummary,
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

describe("role permission summaries", () => {
  it("describes the locked policy for each built-in role", () => {
    expect(rolePermissionSummary("role_implementer")).toContain("Auto-allow");
    expect(rolePermissionSummary("role_developer")).toContain("Auto-allow");
    expect(rolePermissionSummary("role_pr_reviewer")).toContain("Deny file writes");
    expect(rolePermissionSummary("role_planner")).toContain("Deny write and shell");
    expect(rolePermissionSummary("role_general")).toContain("Deny write and shell");
  });
});
