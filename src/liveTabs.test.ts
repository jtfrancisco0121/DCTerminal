import { describe, expect, it } from "vitest";
import type {
  PermissionAutoEvent,
  PermissionRequestEvent,
  PlanRequestEvent,
  PromptFinishedEvent,
  QuestionRequestEvent,
  SessionUpdateEvent,
} from "./bridge";
import {
  applyAutoPermission,
  applyPermission,
  applyPlan,
  clearPlan,
  applyPromptFinished,
  applyQuestion,
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
  it("keeps a plan on the tab that asked and ignores another tab's session", () => {
    const rt = withSession("sess-a");
    const mine: PlanRequestEvent = {
      tabId: "tab-a",
      sessionId: "sess-a",
      jsonRpcId: 4,
      title: "Plan",
      entries: [{ content: "Step 1", status: "pending" }],
    };
    const other = { ...mine, sessionId: "sess-b", jsonRpcId: 5 };
    expect(applyPlan(rt, mine).plan?.jsonRpcId).toBe(4);
    expect(applyPlan(rt, other).plan).toBeNull();
  });

  it("keeps the last submitted plan after the plan card closes", () => {
    const card: PlanRequestEvent = {
      tabId: "tab-1",
      sessionId: "sess-a",
      jsonRpcId: 7,
      title: "Ready to code?",
      entries: [],
      markdown: "# Plan\n1. Patch",
    };
    const shown = applyPlan(withSession("sess-a"), card);
    const closed = clearPlan(shown);
    expect(closed.plan).toBeNull();
    expect(closed.lastPlanMarkdown).toBe("# Plan\n1. Patch");
    // A later card without a body keeps the last real plan.
    expect(applyPlan(closed, { ...card, markdown: null }).lastPlanMarkdown).toBe("# Plan\n1. Patch");
  });

  it("a new plan is fresh again after the user wrote past the last one", () => {
    const card: PlanRequestEvent = {
      tabId: "tab-1",
      sessionId: "sess-a",
      jsonRpcId: 7,
      title: "Ready to code?",
      entries: [],
      markdown: "# Plan v2",
    };
    const stale = { ...withSession("sess-a"), lastPlanMarkdown: "# Plan v1", planStale: true };
    expect(applyPlan(stale, card)).toMatchObject({ lastPlanMarkdown: "# Plan v2", planStale: false });
    // A card without a body does not make the old plan fresh.
    expect(applyPlan(stale, { ...card, markdown: null }).planStale).toBe(true);
  });

  it("keeps a question on the tab that asked and ignores another tab's session", () => {
    const rt = withSession("sess-a");
    const mine: QuestionRequestEvent = {
      tabId: "tab-a",
      sessionId: "sess-a",
      jsonRpcId: 9,
      title: "Pick one",
      prompt: "Which approach?",
      choices: [{ id: "a", label: "A" }],
    };
    const other = { ...mine, sessionId: "sess-b", jsonRpcId: 10 };
    expect(applyQuestion(rt, mine).question?.jsonRpcId).toBe(9);
    expect(applyQuestion(rt, other).question).toBeNull();
  });

  it("clears a pending question when the turn finishes", () => {
    const question: QuestionRequestEvent = {
      tabId: "tab-a",
      sessionId: "sess-a",
      jsonRpcId: 2,
      title: "Q",
      prompt: "Pick",
      choices: [],
    };
    const rt = { ...withSession("sess-a"), question };
    const evt: PromptFinishedEvent = {
      sessionId: "sess-a",
      tabId: "tab-a",
      success: true,
      result: {
        stopReason: "end_turn",
        agentText: "Done",
        updateCount: 1,
      },
      error: null,
      agentExited: false,
    };
    expect(applyPromptFinished(rt, evt).question).toBeNull();
  });

  it("keeps a permission on the tab that asked and ignores another tab's session", () => {
    const rt = withSession("sess-a");
    const mine: PermissionRequestEvent = {
      tabId: "tab-a",
      sessionId: "sess-a",
      jsonRpcId: 7,
      title: "Edit file",
      message: "src/main.rs",
      toolClass: "write",
      displayKind: "edit",
      network: false,
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
      displayKind: "execute",
      network: false,
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

  it("flags both tabs when each has a pending question", () => {
    const question = (tabId: string, sessionId: string, id: number): QuestionRequestEvent => ({
      tabId,
      sessionId,
      jsonRpcId: id,
      title: "Q",
      prompt: "Pick",
      choices: [{ id: "x", label: "X" }],
    });
    const runtimes = {
      a: { ...withSession("s1"), question: question("a", "s1", 1) },
      b: { ...withSession("s2"), question: question("b", "s2", 2) },
    };
    expect(attentionTabIds(runtimes).sort()).toEqual(["a", "b"]);
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
        displayKind: "execute",
        network: false,
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
