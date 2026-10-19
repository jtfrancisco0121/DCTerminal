import { describe, expect, it } from "vitest";
import { chainAfterAgentRequest } from "./chainPause";
import { chainMarkSent, chainStart, type ChainCursor } from "./pad";

const inFlight = (): ChainCursor => chainMarkSent(chainStart("one\n---\ntwo")!);
const thisWindow = [{ id: "tab-1" }, { id: "tab-2" }];

describe("chainAfterAgentRequest", () => {
  it("pauses the chain on a request from one of this window's tabs", () => {
    expect(chainAfterAgentRequest(inFlight(), "tab-2", thisWindow)).toMatchObject({
      phase: "paused",
      reason: "permission",
    });
  });

  it("leaves the chain alone on another window's request", () => {
    const cursor = inFlight();
    expect(chainAfterAgentRequest(cursor, "other-window-tab", thisWindow)).toBe(cursor);
  });

  it("does nothing without a chain", () => {
    expect(chainAfterAgentRequest(null, "tab-1", thisWindow)).toBeNull();
  });
});
