import { describe, expect, it } from "vitest";
import type {
  PermissionAutoEvent,
  PermissionRequestEvent,
  PromptFinishedEvent,
  SessionUpdateEvent,
} from "./bridge";
import {
  applyAutoPermission,
  applyPermission,
  applyPromptFinished,
  applySessionUpdate,
  attentionTabIds,
  clearLiveSession,
  emptyRuntime,
  folderStatusMessage,
  folderTabNotice,
  type TabRuntime,
} from "./liveTabs";

function withSession(sessionId: string): TabRuntime {
  return {
    ...emptyRuntime(),
    session: { sessionId, modeId: "agent", cwd: "C:\\work" },
    accepting: true,
  };
}

describe("per-tab session events", () => {
  it("keeps a permission on the tab that asked and ignores another tab's session", () => {
    const rt = withSession("sess-a");
    const mine: PermissionRequestEvent = {
      tabId: "tab-a",
      sessionId: "sess-a",
      jsonRpcId: 7,
      title: "Edit file",
      message: "src/main.rs",
      toolClass: "write",
      options: [],
      rawParams: "{}",
    };
    const other = { ...mine, sessionId: "sess-b", jsonRpcId: 8 };
    expect(applyPermission(rt, mine).permission?.jsonRpcId).toBe(7);
    expect(applyPermission(rt, other).permission).toBeNull();
  });

  it("appends auto decisions to that tab's transcript", () => {
    const rt = withSession("sess-a");
    const evt: PermissionAutoEvent = {
      tabId: "tab-a",
      sessionId: "sess-a",
      jsonRpcId: 3,
      title: "Shell",
      toolClass: "shell",
      decision: "allow-once",
      line: "Permission auto-allowed (shell): Shell",
    };
    const next = applyAutoPermission(rt, evt);
    expect(next.segments).toHaveLength(1);
    expect(next.segments[0].kind).toBe("system");
    expect(next.segments[0].text).toContain("auto-allowed (shell)");
  });

  it("marks a crashed turn so the tab can restart without hanging", () => {
    const rt = { ...withSession("sess-a"), promptInFlight: true };
    const evt: PromptFinishedEvent = {
      sessionId: "sess-a",
      tabId: "tab-a",
      success: false,
      result: null,
      error: "agent stdout closed",
      agentExited: true,
    };
    const next = applyPromptFinished(rt, evt);
    expect(next.promptInFlight).toBe(false);
    expect(next.agentExited).toBe(true);
    expect(next.promptError).toContain("stdout closed");
  });

  it("ignores prompt results after the tab was stopped", () => {
    const stopped = clearLiveSession(withSession("sess-a"));
    const evt: PromptFinishedEvent = {
      sessionId: "sess-a",
      tabId: "tab-a",
      success: false,
      result: null,
      error: "agent exited",
      agentExited: true,
    };
    expect(applyPromptFinished(stopped, evt).promptError).toBeNull();
  });

  it("routes stream text only to the matching session", () => {
    const rt = withSession("sess-a");
    const evt: SessionUpdateEvent = {
      tabId: "tab-a",
      sessionId: "sess-a",
      kind: "agent_message_chunk",
      textDelta: "Hello",
      rawJson: JSON.stringify({
        update: { type: "agent_message_chunk", text: "Hello" },
      }),
    };
    expect(applySessionUpdate(rt, evt).segments[0]?.text).toBe("Hello");
    expect(
      applySessionUpdate(rt, { ...evt, sessionId: "other" }).segments,
    ).toHaveLength(0);
  });

  it("flags tabs that need attention", () => {
    const runtimes = {
      a: { ...withSession("s1"), permission: {
        tabId: "a",
        sessionId: "s1",
        jsonRpcId: 1,
        title: "Shell",
        message: "",
        toolClass: "shell",
        options: [],
        rawParams: "",
      } },
      b: withSession("s2"),
    };
    expect(attentionTabIds(runtimes)).toEqual(["a"]);
  });
});

describe("restored folder status", () => {
  it("describes a missing, unreadable, or non-directory folder", () => {
    expect(folderStatusMessage("ok", "C:\\ok")).toBeNull();
    expect(folderStatusMessage("missing", "C:\\gone")).toContain("not found");
    expect(folderStatusMessage("unreadable", "C:\\secret")).toContain("not readable");
    expect(folderStatusMessage("not-a-directory", "C:\\file.txt")).toContain("not a directory");
  });

  it("asks to choose a folder when the path is empty", () => {
    expect(folderStatusMessage("missing", "")).toBeNull();
    expect(folderStatusMessage("missing", "   ")).toBeNull();
    expect(folderStatusMessage("empty", "")).toBeNull();
    const notice = folderTabNotice({ status: "missing", savedCwd: "", displayedCwd: "" });
    expect(notice).toEqual({ tone: "hint", text: "Choose a folder" });
    expect(notice?.text).not.toContain("not found");
    expect(
      folderTabNotice({
        status: "missing",
        savedCwd: "",
        displayedCwd: "C:\\Users\\user\\Documents\\Projects\\personal-hub",
      }),
    ).toBeNull();
    expect(
      folderTabNotice({
        status: "missing",
        savedCwd: "C:\\gone",
        displayedCwd: "C:\\gone",
      })?.text,
    ).toContain("C:\\gone");
  });
});
