import { describe, expect, it } from "vitest";
import { coalescedReload, isForRun } from "./overviewRefresh";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("coalescedReload", () => {
  it("fetches at once, then once more for a burst during the fetch", async () => {
    const pending: ReturnType<typeof deferred>[] = [];
    const reload = coalescedReload(() => {
      const next = deferred();
      pending.push(next);
      return next.promise;
    });
    reload.request();
    expect(pending).toHaveLength(1);
    reload.request();
    reload.request();
    reload.request();
    expect(pending).toHaveLength(1);
    pending[0].resolve();
    await flush();
    expect(pending).toHaveLength(2);
    pending[1].resolve();
    await flush();
    expect(pending).toHaveLength(2);
    reload.request();
    expect(pending).toHaveLength(3);
  });

  it("keeps going after a failed fetch and stops on stop()", async () => {
    let calls = 0;
    const reload = coalescedReload(async () => {
      calls += 1;
      throw new Error("offline");
    });
    reload.request();
    await flush();
    reload.request();
    await flush();
    expect(calls).toBe(2);
    reload.stop();
    reload.request();
    await flush();
    expect(calls).toBe(2);
  });
});

describe("isForRun", () => {
  it("matches the run id (an Eagle-Eye run's id is its chain id)", () => {
    expect(isForRun({ chainId: "ee_1" }, "ee_1")).toBe(true);
    expect(isForRun({ chainId: "ee_2" }, "ee_1")).toBe(false);
  });
});
