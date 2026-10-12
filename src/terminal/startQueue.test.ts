import { describe, expect, it } from "vitest";
import { startQueue } from "./startQueue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("startQueue", () => {
  it("runs starts one at a time, in order, and a failure does not stop the next", async () => {
    const enqueue = startQueue(() => false, 1);
    const order: string[] = [];
    let running = 0;
    const task = (name: string, fail = false) => async () => {
      running += 1;
      expect(running).toBe(1);
      order.push(`${name}:start`);
      await tick();
      order.push(`${name}:end`);
      running -= 1;
      if (fail) throw new Error(name);
      return name;
    };
    const results = await Promise.allSettled([enqueue(task("a")), enqueue(task("b", true)), enqueue(task("c"))]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("waits while another start holds the lock instead of failing", async () => {
    let locked = true;
    const enqueue = startQueue(() => locked, 1);
    let ran = false;
    const done = enqueue(async () => {
      ran = true;
      return "tab";
    });
    await tick();
    expect(ran).toBe(false);
    locked = false;
    await expect(done).resolves.toBe("tab");
  });

  it("gives up when the lock is held past the deadline", async () => {
    const enqueue = startQueue(() => true, 1, 20);
    let ran = false;
    await expect(
      enqueue(async () => {
        ran = true;
      }),
    ).rejects.toThrow("Another tab is still starting.");
    expect(ran).toBe(false);
  });
});
