import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  classifyPromptFinished,
  decideNotification,
  dismissToastsForTab,
  notificationMessage,
  pushToast,
  toastLifetimeMs,
  type AgentToast,
  type NotificationSettings,
} from "./agentNotify";

const on: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };

describe("decideNotification", () => {
  it("stays quiet when the tab is visible and the window is focused", () => {
    expect(
      decideNotification({ tabId: "a", visibleTabIds: ["a"], windowFocused: true, settings: on }),
    ).toEqual({ toast: false, system: false });
  });

  it("treats the second split pane as visible", () => {
    expect(
      decideNotification({
        tabId: "b",
        visibleTabIds: ["a", "b"],
        windowFocused: true,
        settings: on,
      }),
    ).toEqual({ toast: false, system: false });
  });

  it("shows only an in-app toast for a background tab while the window is focused", () => {
    expect(
      decideNotification({ tabId: "b", visibleTabIds: ["a"], windowFocused: true, settings: on }),
    ).toEqual({ toast: true, system: false });
  });

  it("uses a system notification and a toast when the window is not focused", () => {
    expect(
      decideNotification({ tabId: "a", visibleTabIds: ["a"], windowFocused: false, settings: on }),
    ).toEqual({ toast: true, system: true });
    expect(
      decideNotification({ tabId: "b", visibleTabIds: ["a"], windowFocused: false, settings: on }),
    ).toEqual({ toast: true, system: true });
  });

  it("does nothing when notifications are off", () => {
    const off = { ...on, enabled: false };
    expect(
      decideNotification({ tabId: "b", visibleTabIds: ["a"], windowFocused: false, settings: off }),
    ).toEqual({ toast: false, system: false });
  });

  it("respects the system and focused-toast toggles separately", () => {
    const noSystem = { ...on, system: false };
    expect(
      decideNotification({
        tabId: "b",
        visibleTabIds: ["a"],
        windowFocused: false,
        settings: noSystem,
      }),
    ).toEqual({ toast: true, system: false });
    const noFocusedToast = { ...on, toastWhenFocused: false };
    expect(
      decideNotification({
        tabId: "b",
        visibleTabIds: ["a"],
        windowFocused: true,
        settings: noFocusedToast,
      }),
    ).toEqual({ toast: false, system: false });
  });
});

describe("classifyPromptFinished", () => {
  const base = { sessionId: "s", tabId: "t", agentExited: false };

  it("reports a finished turn", () => {
    expect(
      classifyPromptFinished({
        ...base,
        success: true,
        error: null,
        result: { stopReason: "end_turn", agentText: "Done. Tests pass.", updateCount: 3 },
      }),
    ).toEqual({ kind: "finished", detail: "Done. Tests pass." });
  });

  it("reports a question when the agent's last line asks one", () => {
    expect(
      classifyPromptFinished({
        ...base,
        success: true,
        error: null,
        result: {
          stopReason: "end_turn",
          agentText: "I found two configs.\n\nWhich one should I update?",
          updateCount: 3,
        },
      }),
    ).toEqual({ kind: "question", detail: "Which one should I update?" });
  });

  it("ignores a turn the user cancelled", () => {
    expect(
      classifyPromptFinished({
        ...base,
        success: true,
        error: null,
        result: { stopReason: "cancelled", agentText: "", updateCount: 0 },
      }),
    ).toBeNull();
  });

  it("reports a failed turn with its error", () => {
    expect(
      classifyPromptFinished({
        ...base,
        success: false,
        error: "agent exited",
        result: null,
        agentExited: true,
      }),
    ).toEqual({ kind: "failed", detail: "agent exited" });
  });

  it("ignores events with no tab", () => {
    expect(
      classifyPromptFinished({
        ...base,
        tabId: null,
        success: true,
        error: null,
        result: { stopReason: "end_turn", agentText: "ok", updateCount: 1 },
      }),
    ).toBeNull();
  });
});

describe("notificationMessage", () => {
  it("names the tab and the event", () => {
    expect(notificationMessage({ kind: "finished", detail: "All set." }, "Implementer")).toEqual({
      title: "Implementer finished",
      body: "All set.",
    });
    expect(notificationMessage({ kind: "permission", detail: "Run npm test" }, "Reviewer")).toEqual(
      { title: "Reviewer needs permission", body: "Run npm test" },
    );
    expect(notificationMessage({ kind: "question", detail: "Which one?" }, "Planner").title).toBe(
      "Planner has a question",
    );
    expect(notificationMessage({ kind: "plan", detail: "" }, "Planner")).toEqual({
      title: "Planner has a plan to review",
      body: "Open the tab to accept or reject the plan.",
    });
    expect(notificationMessage({ kind: "failed", detail: "boom" }, "Dev").title).toBe(
      "Dev stopped with an error",
    );
  });

  it("falls back to a generic body and a generic tab name", () => {
    expect(notificationMessage({ kind: "finished", detail: "   " }, "")).toEqual({
      title: "Agent finished",
      body: "The agent finished its turn.",
    });
  });

  it("keeps the body short and on one line", () => {
    const long = `${"word ".repeat(80)}\nsecond line`;
    const { body } = notificationMessage({ kind: "finished", detail: long }, "Tab");
    expect(body.length).toBeLessThanOrEqual(140);
    expect(body).not.toContain("\n");
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("toast list", () => {
  const toast = (id: string, tabId: string, kind: AgentToast["kind"] = "finished"): AgentToast => ({
    id,
    tabId,
    kind,
    title: id,
    body: "",
  });

  it("keeps one toast per tab, newest first", () => {
    let list: AgentToast[] = [];
    list = pushToast(list, toast("1", "a"));
    list = pushToast(list, toast("2", "b"));
    list = pushToast(list, toast("3", "a", "permission"));
    expect(list.map((t) => t.id)).toEqual(["3", "2"]);
  });

  it("caps the stack", () => {
    let list: AgentToast[] = [];
    for (let i = 0; i < 8; i += 1) list = pushToast(list, toast(String(i), `t${i}`), 4);
    expect(list.map((t) => t.id)).toEqual(["7", "6", "5", "4"]);
  });

  it("drops a tab's toasts once the user opens that tab", () => {
    const list = [toast("1", "a"), toast("2", "b")];
    expect(dismissToastsForTab(list, "a").map((t) => t.id)).toEqual(["2"]);
    expect(dismissToastsForTab(list, "zzz")).toBe(list);
  });

  it("keeps needs-you toasts on screen longer", () => {
    expect(toastLifetimeMs("permission")).toBeGreaterThan(toastLifetimeMs("finished"));
    expect(toastLifetimeMs("question")).toBeGreaterThan(toastLifetimeMs("finished"));
  });
});
