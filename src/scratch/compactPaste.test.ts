import { describe, expect, it } from "vitest";
import {
  applyCompact,
  COMPACT_MIN_CHARS,
  compactOfferFor,
  offerStillValid,
  undoCompact,
} from "./compactPaste";

const noisyLog = Array.from({ length: 200 }, (_, i) => `  fetched chunk ${i} of 200`).join("\n");

describe("compact paste offer", () => {
  it("offers nothing for a short clean paste", () => {
    expect(compactOfferFor("fix the parser", 0)).toBeNull();
  });

  it("offers nothing when compacting saves little", () => {
    const prose = "word ".repeat(COMPACT_MIN_CHARS);
    expect(compactOfferFor(prose, 0)).toBeNull();
  });

  it("offers a large repetitive paste", () => {
    expect(noisyLog.length).toBeGreaterThan(COMPACT_MIN_CHARS);
    const offer = compactOfferFor(noisyLog, 4);
    expect(offer).not.toBeNull();
    expect(offer?.compacted).toBe("  fetched chunk 199 of 200 [×200]");
    expect(offer?.at).toBe(4);
    expect(offer?.applied).toBe(false);
  });

  it("offers a short paste with colour codes", () => {
    const offer = compactOfferFor("\x1b[31merror\x1b[0m: one\n\x1b[31merror\x1b[0m: one\n", 0);
    expect(offer?.compacted).toBe("error: one [×2]");
  });

  it("compacts in place and undoes back to the original", () => {
    const offer = compactOfferFor(noisyLog, 4)!;
    const pad = `see ${noisyLog} thanks`;
    const compacted = applyCompact(pad, offer);
    expect(compacted).toBe(`see ${offer.compacted} thanks`);
    const applied = { ...offer, applied: true };
    expect(offerStillValid(compacted!, applied)).toBe(true);
    expect(undoCompact(compacted!, applied)).toBe(pad);
  });

  it("finds the paste after earlier edits moved it", () => {
    const offer = compactOfferFor(noisyLog, 0)!;
    expect(applyCompact(`moved ${noisyLog}`, offer)).toBe(`moved ${offer.compacted}`);
  });

  it("drops out once the paste is gone", () => {
    const offer = compactOfferFor(noisyLog, 0)!;
    expect(offerStillValid("", offer)).toBe(false);
    expect(applyCompact("", offer)).toBeNull();
    expect(undoCompact("", { ...offer, applied: true })).toBeNull();
  });
});
