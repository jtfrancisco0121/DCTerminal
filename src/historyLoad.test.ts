import { describe, expect, it } from "vitest";
import { loadHistoryInTwoPasses } from "./historyLoad";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("loadHistoryInTwoPasses", () => {
  it("shows the quick rows first, then replaces them with the full rows", async () => {
    const quick = deferred<string[]>();
    const full = deferred<string[]>();
    const shown: string[][] = [];
    const done = loadHistoryInTwoPasses(() => quick.promise, () => full.promise, (rows) => shown.push(rows), () => false);
    quick.resolve(["own"]);
    await flush();
    expect(shown).toEqual([["own"]]);
    full.resolve(["own", "stray"]);
    await done;
    expect(shown).toEqual([["own"], ["own", "stray"]]);
  });

  it("ignores a quick pass that ends after the full one, or fails", async () => {
    const quick = deferred<string[]>();
    const shown: string[][] = [];
    await loadHistoryInTwoPasses(() => quick.promise, async () => ["all"], (rows) => shown.push(rows), () => false);
    quick.resolve(["late"]);
    await flush();
    expect(shown).toEqual([["all"]]);

    const failing: string[][] = [];
    await loadHistoryInTwoPasses(async () => Promise.reject(new Error("no")), async () => ["all"], (rows) => failing.push(rows), () => false);
    await flush();
    expect(failing).toEqual([["all"]]);
  });

  it("shows nothing once cancelled and passes the full pass's error on", async () => {
    const shown: string[][] = [];
    await loadHistoryInTwoPasses(async () => ["own"], async () => ["all"], (rows) => shown.push(rows), () => true);
    expect(shown).toEqual([]);
    await expect(
      loadHistoryInTwoPasses(null, async () => Promise.reject(new Error("boom")), () => {}, () => false),
    ).rejects.toThrow("boom");
  });
});
