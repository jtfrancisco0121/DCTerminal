import { describe, expect, it } from "vitest";
import { createTurnWaiter } from "./turnWait";

describe("ACP turn waiter", () => {
  it("resolves only when the prompt-finished event arrives", async () => {
    const waiter = createTurnWaiter();
    const pending = waiter.expect("tab_1");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    waiter.notify({ tabId: "tab_1", success: true, stopReason: "end_turn" });
    await expect(pending).resolves.toBe("completed");
  });

  it("keeps an early finish if the event beats the waiter", async () => {
    const waiter = createTurnWaiter();
    waiter.notify({ tabId: "tab_1", success: false, error: "cancelled by user" });
    await expect(waiter.expect("tab_1")).resolves.toBe("cancelled");
  });
});
