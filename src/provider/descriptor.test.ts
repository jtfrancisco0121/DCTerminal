import { describe, expect, it } from "vitest";
import {
  CLAUDE_FALLBACK_MODELS,
  modelsForProvider,
  providerIndicator,
  providerTooltipLine,
  shortAccount,
  tabHasProvider,
} from "./descriptor";
import { defaultProvidersSettings, providerForRole } from "./types";

const dir = {
  path: "/Users/jt/.claude-account2",
  display: "~/.claude-account2",
  source: "setting" as const,
  exists: true,
};
const signedIn = {
  state: "loggedIn",
  account: "jt@koneksi.co.kr",
  detail: null,
  apiKeyEnv: false,
  method: "claude.ai · team",
};

describe("provider descriptor", () => {
  it("builds the Claude status bar text and tooltip", () => {
    const shown = providerIndicator("claude", { configDir: dir, login: signedIn });
    expect(shown.text).toBe("Claude · ~/.claude-account2 · jt@…");
    expect(shown.title).toContain("Config folder: /Users/jt/.claude-account2");
    expect(shown.title).toContain("Account: jt@koneksi.co.kr");
    expect(shown.title).toContain("Login: claude.ai · team");
    expect(providerTooltipLine("claude", { configDir: dir, login: signedIn })).toBe(
      "Claude · /Users/jt/.claude-account2 · jt@koneksi.co.kr",
    );
  });

  it("says when the folder is not signed in", () => {
    const login = { state: "loggedOut", account: null, detail: null, apiKeyEnv: false };
    expect(providerIndicator("claude", { configDir: dir, login }).text).toBe(
      "Claude · ~/.claude-account2 · not signed in",
    );
    expect(providerTooltipLine("claude", { configDir: dir, login })).toBe(
      "Claude · /Users/jt/.claude-account2 · not signed in",
    );
  });

  it("keeps Cursor short", () => {
    expect(providerIndicator("cursor").text).toBe("Cursor");
    expect(providerTooltipLine("cursor", { configDir: dir, login: signedIn })).toBe("Cursor");
  });

  it("switches the model list with the provider", () => {
    const cursor = [{ id: "composer-2.5", label: "Composer 2.5", fast: false }];
    expect(modelsForProvider("cursor", cursor)).toBe(cursor);
    expect(modelsForProvider("claude", cursor).map((m) => m.id)).toEqual([
      "default",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(CLAUDE_FALLBACK_MODELS[0].id).toBe("default");
  });

  it("remembers the provider per role, else the default", () => {
    const settings = { ...defaultProvidersSettings(), roleProvider: { role_planner: "cursor", x: "bad" } };
    expect(providerForRole(settings, "role_planner")).toBe("cursor");
    expect(providerForRole(settings, "role_developer")).toBe("claude");
    expect(providerForRole(settings, "x")).toBe("claude");
    expect(providerForRole(null, "role_developer")).toBe("claude");
  });

  it("only agent tabs carry a provider", () => {
    expect(tabHasProvider({ kind: "role" })).toBe(true);
    expect(tabHasProvider({ kind: "terminal", terminalLaunch: "role" })).toBe(true);
    expect(tabHasProvider({ kind: "terminal", terminalLaunch: "cursor-cli" })).toBe(true);
    expect(tabHasProvider({ kind: "terminal", terminalLaunch: "claude-cli" })).toBe(true);
    expect(tabHasProvider({ kind: "terminal", terminalLaunch: "shell" })).toBe(false);
    expect(shortAccount("Example Org")).toBe("Example Org");
  });
});
