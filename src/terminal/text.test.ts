import { describe, expect, it } from "vitest";
import { lastLines, stripAnsi, TERMINAL_TAIL_LINES } from "./text";

describe("terminal text", () => {
  it("strips color and cursor sequences", () => {
    const raw = "\u001B[32mplan\u001B[0m \u001B[1;31mready\u001B[m\r\n\u001B]0;title\u0007next";
    expect(stripAnsi(raw)).toBe("plan ready\r\nnext");
  });

  it("keeps the last N lines of a long buffer", () => {
    const lines = Array.from({ length: TERMINAL_TAIL_LINES + 5 }, (_, i) => `line ${i}`);
    const tail = lastLines(lines.join("\n"));
    expect(tail.startsWith(`line 5`)).toBe(true);
    expect(tail.endsWith(`line ${TERMINAL_TAIL_LINES + 4}`)).toBe(true);
    expect(tail.split("\n")).toHaveLength(TERMINAL_TAIL_LINES);
  });
});
