import { describe, expect, it } from "vitest";
import claudeTurn from "../../fixtures/acp/claude/prompt-turn.json";
import claudeLoad from "../../fixtures/acp/claude/session-load.json";
import type { SessionUpdateEvent } from "../bridge";
import { applySessionUpdate, clearLiveSession, emptyRuntime } from "../liveTabs";
import {
  blockedSlashCommand,
  blockedSlashCommandIn,
  filterSlashCommands,
  insertSlashCommand,
  isBlockedCommand,
  parseAvailableCommands,
  slashQueryAt,
  type SlashCommand,
} from "./slashCommands";

function eventFrom(params: unknown, kind = "available_commands_update"): SessionUpdateEvent {
  return { tabId: "t1", sessionId: "s1", kind, textDelta: null, rawJson: JSON.stringify(params) };
}

function commandsUpdate(availableCommands: unknown): SessionUpdateEvent {
  return eventFrom({
    sessionId: "s1",
    update: { sessionUpdate: "available_commands_update", availableCommands },
  });
}

function fixtureUpdates(fixture: { messages: Array<Record<string, unknown>> }) {
  return fixture.messages
    .filter((m) => m.method === "session/update")
    .map((m) => {
      const params = m.params as { update: { sessionUpdate: string } };
      return eventFrom(params, params.update.sessionUpdate);
    });
}

const cmd = (name: string, description = ""): SlashCommand => ({ name, description, hint: null });

describe("parseAvailableCommands", () => {
  it("reads the Claude fixture shape", () => {
    const parsed = fixtureUpdates(claudeTurn)
      .map(parseAvailableCommands)
      .filter((list) => list !== null);
    expect(parsed).toEqual([
      [{ name: "example-skill", description: "(redacted: 63 user commands/skills)", hint: null }],
    ]);
  });

  it("ignores other session updates", () => {
    expect(
      parseAvailableCommands(eventFrom({ update: { sessionUpdate: "usage_update" } }, "usage_update")),
    ).toBeNull();
  });

  it("keeps the input hint and drops blocked, duplicate, and malformed entries", () => {
    const list = parseAvailableCommands(
      commandsUpdate([
        { name: "review", description: "Review a PR", input: { hint: "PR number" } },
        { name: "/init", description: "Write CLAUDE.md", input: null },
        { name: "model", description: "Switch model" },
        { name: "login" },
        { name: "logout" },
        { name: "review", description: "dup" },
        { name: "two words" },
        { description: "no name" },
        "garbage",
        null,
      ]),
    );
    expect(list).toEqual([
      { name: "review", description: "Review a PR", hint: "PR number" },
      { name: "init", description: "Write CLAUDE.md", hint: null },
    ]);
  });

  it("returns an empty list for an empty or broken update", () => {
    expect(parseAvailableCommands(commandsUpdate([]))).toEqual([]);
    expect(parseAvailableCommands(commandsUpdate("nope"))).toEqual([]);
    expect(
      parseAvailableCommands({ ...commandsUpdate([]), rawJson: "{not json" }),
    ).toEqual([]);
  });
});

describe("tab runtime", () => {
  it("keeps the latest list, including the one replayed by session/load", () => {
    let rt = { ...emptyRuntime(), accepting: true };
    for (const evt of fixtureUpdates(claudeLoad)) rt = applySessionUpdate(rt, evt);
    expect(rt.slashCommands.map((c) => c.description)).toEqual([
      "(redacted: 65 user commands/skills)",
    ]);
    rt = applySessionUpdate(rt, commandsUpdate([{ name: "review" }]));
    expect(rt.slashCommands.map((c) => c.name)).toEqual(["review"]);
    expect(rt.segments.some((s) => s.text.includes("review"))).toBe(false);
    expect(clearLiveSession(rt).slashCommands).toEqual([]);
  });
});

describe("filterSlashCommands", () => {
  const list = [cmd("review", "Review a PR"), cmd("init"), cmd("pr-comments", "review comments"), cmd("model")];

  it("lists every allowed command for a bare slash", () => {
    expect(filterSlashCommands(list, "").map((c) => c.name)).toEqual(["review", "init", "pr-comments"]);
  });

  it("puts name prefix matches before other matches, ignoring case", () => {
    expect(filterSlashCommands(list, "REV").map((c) => c.name)).toEqual(["review", "pr-comments"]);
    expect(filterSlashCommands(list, "comm").map((c) => c.name)).toEqual(["pr-comments"]);
    expect(filterSlashCommands(list, "zzz")).toEqual([]);
  });

  it("never offers blocked commands", () => {
    expect(filterSlashCommands(list, "mod")).toEqual([]);
  });
});

describe("blocked commands", () => {
  it("recognizes /model, /login, and /logout", () => {
    expect(isBlockedCommand("model")).toBe(true);
    expect(isBlockedCommand("/Login")).toBe(true);
    expect(isBlockedCommand("logout")).toBe(true);
    expect(isBlockedCommand("review")).toBe(false);
  });

  it("warns for a prompt that starts with one", () => {
    expect(blockedSlashCommand("/model opus")).toContain("Use the model picker");
    expect(blockedSlashCommand("  /model")).toContain("Use the model picker");
    expect(blockedSlashCommand("/login")).toContain("/login");
    expect(blockedSlashCommand("/logout\nplease")).toContain("/logout");
  });

  it("allows other prompts", () => {
    expect(blockedSlashCommand("/models-guide")).toBeNull();
    expect(blockedSlashCommand("/review 12")).toBeNull();
    expect(blockedSlashCommand("explain /model")).toBeNull();
    expect(blockedSlashCommand("")).toBeNull();
  });

  it("checks every chain step", () => {
    expect(blockedSlashCommandIn(["/review", "/model sonnet"])).toContain("model picker");
    expect(blockedSlashCommandIn(["/review", "hello"])).toBeNull();
  });
});

describe("slashQueryAt and insertSlashCommand", () => {
  it("finds a slash word at the start of the input or of a line", () => {
    expect(slashQueryAt("/rev", 4)).toEqual({ start: 0, query: "rev" });
    expect(slashQueryAt("/", 1)).toEqual({ start: 0, query: "" });
    expect(slashQueryAt("first\n/in", 9)).toEqual({ start: 6, query: "in" });
  });

  it("ignores a slash mid-line or once a space is typed", () => {
    expect(slashQueryAt("see /rev", 8)).toBeNull();
    expect(slashQueryAt("/review now", 11)).toBeNull();
    expect(slashQueryAt("a/b", 3)).toBeNull();
  });

  it("replaces the typed word with /name and a space", () => {
    expect(insertSlashCommand("/rev", 4, "review")).toEqual({ text: "/review ", caret: 8 });
    expect(insertSlashCommand("intro\n/i\nmore", 8, "init")).toEqual({
      text: "intro\n/init \nmore",
      caret: 12,
    });
    expect(insertSlashCommand("/re 12", 3, "review")).toEqual({ text: "/review 12", caret: 8 });
    expect(insertSlashCommand("/review", 3, "review")).toEqual({ text: "/review ", caret: 8 });
  });

  it("leaves text alone when the caret is not on a slash word", () => {
    expect(insertSlashCommand("hello", 5, "review")).toEqual({ text: "hello", caret: 5 });
  });
});
