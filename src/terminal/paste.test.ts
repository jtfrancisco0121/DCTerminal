import { describe, expect, it } from "vitest";
import { encodeTerminalPaste } from "./paste";

describe("terminal paste encoding", () => {
  it("wraps a multiline prompt when bracketed paste is on and submits once", () => {
    const encoded = encodeTerminalPaste("line1\nline2", {
      bracketedPaste: true,
      submit: true,
    });
    expect(encoded).toBe("\u001b[200~line1\nline2\u001b[201~\r");
    expect(encoded.match(/\r/g)).toEqual(["\r"]);
  });

  it("pastes without a final Enter", () => {
    const encoded = encodeTerminalPaste("line1\r\nline2", {
      bracketedPaste: true,
      submit: false,
    });
    expect(encoded).toBe("\u001b[200~line1\nline2\u001b[201~");
    expect(encoded).not.toContain("\r");
  });

  it("keeps newlines and does not submit when bracketed paste is off", () => {
    const encoded = encodeTerminalPaste("line1\nline2", {
      bracketedPaste: false,
      submit: false,
    });
    expect(encoded).toBe("line1\nline2");
    expect(encoded).not.toContain("\u001b");
    expect(encoded).not.toContain("\r");
  });
});
