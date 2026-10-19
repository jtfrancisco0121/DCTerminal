import { describe, expect, it, vi } from "vitest";
import { runStartupSteps } from "./startupSteps";

describe("runStartupSteps", () => {
  it("runs every step in order and reports no failure", async () => {
    const order: string[] = [];
    const failure = await runStartupSteps([
      { title: "one", run: async () => void order.push("one") },
      { title: "two", run: async () => void order.push("two") },
    ]);
    expect(failure).toBeNull();
    expect(order).toEqual(["one", "two"]);
  });

  it("stops at a failed step, and a retry runs that step again and then the rest", async () => {
    const select = vi.fn().mockRejectedValueOnce(new Error("role not found")).mockResolvedValue(undefined);
    const after = vi.fn(async () => {});
    const before = vi.fn(async () => {});
    const failure = await runStartupSteps([
      { title: "before", run: before },
      { title: "Active tab did not load", run: select },
      { title: "after", run: after },
    ]);
    expect(failure?.title).toBe("Active tab did not load");
    expect((failure?.error as Error).message).toBe("role not found");
    expect(after).not.toHaveBeenCalled();

    expect(await failure!.retry()).toBeNull();
    expect(before).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("a retry that fails again offers another retry", async () => {
    const step = vi.fn().mockRejectedValue(new Error("still down"));
    const first = await runStartupSteps([{ title: "step", run: step }]);
    const second = await first!.retry();
    expect(second?.title).toBe("step");
    expect(step).toHaveBeenCalledTimes(2);
  });
});
