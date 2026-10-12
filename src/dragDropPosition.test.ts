// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropPointToCss, elementAtDropPosition } from "./dragDropPosition";

describe("dropPointToCss", () => {
  it("keeps macOS and Linux positions as they are, even on a 2x screen", () => {
    expect(dropPointToCss({ x: 1000, y: 700 }, "mac", 2)).toEqual({ x: 1000, y: 700 });
    expect(dropPointToCss({ x: 1000, y: 700 }, "linux", 2)).toEqual({ x: 1000, y: 700 });
  });

  it("divides Windows device pixels by the scale", () => {
    expect(dropPointToCss({ x: 1000, y: 700 }, "windows", 2)).toEqual({ x: 500, y: 350 });
    expect(dropPointToCss({ x: 1000, y: 700 }, "windows", 0)).toEqual({ x: 1000, y: 700 });
  });
});

describe("elementAtDropPosition", () => {
  const original = { dpr: window.devicePixelRatio, efp: document.elementFromPoint };
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "devicePixelRatio", { value: original.dpr, configurable: true });
    document.elementFromPoint = original.efp;
  });

  const setup = (platform: string) => {
    vi.stubGlobal("navigator", { ...navigator, platform });
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    const efp = vi.fn().mockReturnValue(document.body);
    document.elementFromPoint = efp;
    return efp;
  };

  it("hit-tests the reported point on a Retina Mac", () => {
    const efp = setup("MacIntel");
    expect(elementAtDropPosition({ x: 1000, y: 700 })).toBe(document.body);
    expect(efp).toHaveBeenCalledWith(1000, 700);
  });

  it("hit-tests the reported point on Linux HiDPI", () => {
    const efp = setup("Linux x86_64");
    elementAtDropPosition({ x: 1000, y: 700 });
    expect(efp).toHaveBeenCalledWith(1000, 700);
  });

  it("scales the point down on Windows", () => {
    const efp = setup("Win32");
    elementAtDropPosition({ x: 1000, y: 700 });
    expect(efp).toHaveBeenCalledWith(500, 350);
  });
});
