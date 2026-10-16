import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({ filesResolve: vi.fn(async () => []) }));

import { existingPaths, RESOLVE_CACHE_MS, setFileResolver } from "./fileLinks";

afterEach(() => setFileResolver(null));

describe("existingPaths", () => {
  it("asks once per batch and keeps only existing paths", async () => {
    const resolve = vi.fn(async (_tab: string, paths: string[]) => paths.filter((p) => p !== "nope.ts"));
    setFileResolver(resolve);
    const found = await existingPaths("t1", ["a.ts", "nope.ts", "a.ts"], 1000);
    expect([...found]).toEqual(["a.ts"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("t1", ["a.ts", "nope.ts"]);
  });

  it("serves repeats from the cache until it expires", async () => {
    const resolve = vi.fn(async (_tab: string, paths: string[]) => paths);
    setFileResolver(resolve);
    await existingPaths("t1", ["a.ts"], 1000);
    await existingPaths("t1", ["a.ts"], 1000 + RESOLVE_CACHE_MS - 1);
    expect(resolve).toHaveBeenCalledTimes(1);
    await existingPaths("t1", ["a.ts"], 1000 + RESOLVE_CACHE_MS + 1);
    expect(resolve).toHaveBeenCalledTimes(2);
    await existingPaths("t2", ["a.ts"], 1000 + RESOLVE_CACHE_MS + 1);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("links nothing when the check fails", async () => {
    setFileResolver(vi.fn(async () => Promise.reject(new Error("unknown tab"))));
    expect((await existingPaths("t1", ["a.ts"])).size).toBe(0);
  });
});
