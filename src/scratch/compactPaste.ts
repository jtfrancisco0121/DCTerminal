/**
 * The scratch pad's "Compact this paste" offer. A large paste (or one with
 * terminal colours or redrawn progress lines) gets an inline offer; nothing
 * changes until the user picks it, and Undo puts the original back.
 */
import { compactText } from "./compactText";

/** Pastes at least this long get the offer. */
export const COMPACT_MIN_CHARS = 2000;

/** A paste that could be compacted: where it landed, and both versions. */
export type PasteOffer = {
  /** The paste as the textarea holds it (line breaks as `\n`). */
  original: string;
  compacted: string;
  /** Where the paste starts in the pad. */
  at: number;
  /** Set once compacted, so Undo knows to put `original` back. */
  applied: boolean;
};

// Colour codes, or a bare \r that redraws a line (progress bars).
const NOISY = /\x1b\[|\r(?!\n)/;

/**
 * The offer for a paste at `at`, or null when the paste is small and clean,
 * or when compacting would not save much (under a fifth).
 */
export function compactOfferFor(pasted: string, at: number): PasteOffer | null {
  if (!pasted || (pasted.length < COMPACT_MIN_CHARS && !NOISY.test(pasted))) return null;
  const original = pasted.replace(/\r\n?/g, "\n");
  const { text } = compactText(pasted);
  if (text === original || text.length > original.length * 0.8) return null;
  return { original, compacted: text, at, applied: false };
}

/** Replace `from` with `to` at `at`, or at its first copy when the pad moved on. */
function swap(content: string, from: string, to: string, at: number): string | null {
  const index = content.startsWith(from, at) ? at : content.indexOf(from);
  if (index < 0) return null;
  return content.slice(0, index) + to + content.slice(index + from.length);
}

/** The pad after compacting the paste, or null when the paste is gone. */
export function applyCompact(content: string, offer: PasteOffer): string | null {
  return swap(content, offer.original, offer.compacted, offer.at);
}

/** The pad with the original paste back, or null when the compacted text is gone. */
export function undoCompact(content: string, offer: PasteOffer): string | null {
  return swap(content, offer.compacted, offer.original, offer.at);
}

/** Whether the offer still matches the pad (the paste was not sent or edited away). */
export function offerStillValid(content: string, offer: PasteOffer): boolean {
  return content.includes(offer.applied ? offer.compacted : offer.original);
}
