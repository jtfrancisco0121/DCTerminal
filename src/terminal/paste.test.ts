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

describe("pasted text is cleaned", () => {
  it("drops a paste end marker inside the text, so later lines stay in the paste", () => {
    const encoded = encodeTerminalPaste("copied output\x1b[201~\nrm -rf build\n", {
      bracketedPaste: true,
      submit: true,
    });
    expect(encoded).toBe("\u001b[200~copied output\nrm -rf build\n\u001b[201~\r");
    expect(encoded.split("\u001b[201~")).toHaveLength(2);
    expect(encoded.match(/\r/g)).toEqual(["\r"]);
  });

  it("strips escape sequences and control bytes but keeps tabs and newlines", () => {
    const text =
      "\x1b[200~a\tb\x1b[0m\x1b[1;31mred\x1b]0;title\x07\x1bPdcs\x1b\\\x1b7c\x00\x08\x7f\x1b\rd\r\ne";
    expect(encodeTerminalPaste(text, { bracketedPaste: false, submit: false })).toBe("a\tbredc\nd\ne");
  });
});
