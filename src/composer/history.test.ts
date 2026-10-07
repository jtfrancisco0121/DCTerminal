import { describe, expect, it } from "vitest";
import { pushComposerHistory } from "./history";

describe("pushComposerHistory", () => {
  it("appends and caps the ring buffer", () => {
    let history: string[] = [];
    for (let i = 0; i < 55; i += 1) {
      history = pushComposerHistory(history, `line ${i}`, 50);
    }
    expect(history).toHaveLength(50);
    expect(history[0]).toBe("line 5");
    expect(history[49]).toBe("line 54");
  });

  it("moves a repeated send to the end without duplicates", () => {
    const history = pushComposerHistory(["a", "b"], "a");
    expect(history).toEqual(["b", "a"]);
  });
});
