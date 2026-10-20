import { describe, expect, it } from "vitest";
import type { ProviderModelSettings, TabSummary } from "../bridge";
import { HAIKU_DEFAULT_MODE_NOTE, haikuDefaultModeNote, isHaikuModel } from "./haikuMode";

const tab = (partial: Partial<TabSummary>): TabSummary => ({
  id: "tab_impl",
  label: "Implementer",
  roleId: "role_implementer",
  cwd: "/repo",
  phase: "running",
  mergedPromptChars: 0,
  startupPromptSent: true,
  hasTranscript: false,
  folderStatus: "ok",
  color: "",
  kind: "terminal",
  terminalLaunch: "role",
  acpSessionId: null,
  provider: "claude",
  permissionMode: "auto",
  ...partial,
});

const settings = (roleModels: Record<string, string>, defaultModel = "default"): ProviderModelSettings => ({
  cursor: { defaultModel: "composer-2.5", roleModels: {} },
  claude: { defaultModel, roleModels },
});

describe("haikuMode (D12a)", () => {
  it("knows Haiku by its alias or its full id", () => {
    expect(isHaikuModel("haiku")).toBe(true);
    expect(isHaikuModel("claude-haiku-4-5-20251001")).toBe(true);
    expect(isHaikuModel(" haiku[1m] ")).toBe(true);
    expect(isHaikuModel("sonnet")).toBe(false);
    expect(isHaikuModel("default")).toBe(false);
    expect(isHaikuModel("claude-opus-4-1")).toBe(false);
  });

  it("notes an auto-mode Claude stage whose role, tab or default model is Haiku", () => {
    expect(haikuDefaultModeNote(tab({}), settings({ role_implementer: "haiku" }))).toBe(HAIKU_DEFAULT_MODE_NOTE);
    expect(haikuDefaultModeNote(tab({ model: "claude-haiku-4-5" }), settings({}))).toBe(HAIKU_DEFAULT_MODE_NOTE);
    expect(haikuDefaultModeNote(tab({}), settings({}, "haiku"))).toBe(HAIKU_DEFAULT_MODE_NOTE);
    // The tab's own model wins over a Haiku role default.
    expect(haikuDefaultModeNote(tab({ model: "opus" }), settings({ role_implementer: "haiku" }))).toBeNull();
  });

  it("says nothing for other models, other modes or non-Claude tabs", () => {
    expect(haikuDefaultModeNote(tab({}), settings({ role_implementer: "sonnet" }))).toBeNull();
    expect(haikuDefaultModeNote(tab({}), null)).toBeNull();
    // The Planner runs in plan mode, not auto.
    expect(haikuDefaultModeNote(tab({ permissionMode: "plan" }), settings({ role_implementer: "haiku" }))).toBeNull();
    expect(haikuDefaultModeNote(tab({ permissionMode: null }), settings({ role_implementer: "haiku" }))).toBeNull();
    expect(haikuDefaultModeNote(tab({ provider: "cursor" }), settings({ role_implementer: "haiku" }))).toBeNull();
    expect(haikuDefaultModeNote(undefined, settings({ role_implementer: "haiku" }))).toBeNull();
  });

  it("says the session silently runs in default and asks more often", () => {
    expect(HAIKU_DEFAULT_MODE_NOTE).toMatch(/Haiku/);
    expect(HAIKU_DEFAULT_MODE_NOTE).toMatch(/default/);
    expect(HAIKU_DEFAULT_MODE_NOTE).toMatch(/auto mode is unavailable/i);
    expect(HAIKU_DEFAULT_MODE_NOTE).toMatch(/asks before risky actions more often/);
  });
});
