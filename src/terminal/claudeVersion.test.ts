// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeVersionWarning,
  compareClaudeVersion,
  resetClaudeVersionNotices,
  TESTED_CLAUDE_VERSION,
  useClaudeVersionNotice,
} from "./claudeVersion";

describe("compareClaudeVersion", () => {
  it("is a match for the tested version, with or without the CLI's suffix", () => {
    expect(compareClaudeVersion("2.1.287")).toBe("match");
    expect(compareClaudeVersion("2.1.287 (Claude Code)")).toBe("match");
    expect(compareClaudeVersion("  v2.1.287\n")).toBe("match");
  });

  it("tells a newer version from an older one, part by part", () => {
    expect(compareClaudeVersion("2.1.288 (Claude Code)")).toBe("newer");
    expect(compareClaudeVersion("2.2.0")).toBe("newer");
    expect(compareClaudeVersion("3.0.0")).toBe("newer");
    expect(compareClaudeVersion("2.1.236 (Claude Code)")).toBe("older");
    expect(compareClaudeVersion("2.0.999")).toBe("older");
    expect(compareClaudeVersion("1.9.300")).toBe("older");
  });

  it("is unknown, not a mismatch, when the version is missing or unreadable", () => {
    expect(compareClaudeVersion(null)).toBe("unknown");
    expect(compareClaudeVersion(undefined)).toBe("unknown");
    expect(compareClaudeVersion("")).toBe("unknown");
    expect(compareClaudeVersion("test")).toBe("unknown");
    expect(compareClaudeVersion("2.1")).toBe("unknown");
    expect(compareClaudeVersion("Claude Code")).toBe("unknown");
  });
});

describe("claudeVersionWarning", () => {
  it("names both versions and what to do, only on a mismatch", () => {
    const text = claudeVersionWarning("2.1.300 (Claude Code)");
    expect(text).toContain(`Needs-you detection was written for Claude Code ${TESTED_CLAUDE_VERSION}`);
    expect(text).toContain("you have 2.1.300");
    expect(text).toContain("answer in the terminal and tell JT");
    expect(claudeVersionWarning(`${TESTED_CLAUDE_VERSION} (Claude Code)`)).toBeNull();
    expect(claudeVersionWarning(null)).toBeNull();
    expect(claudeVersionWarning("garbage")).toBeNull();
  });
});

describe("useClaudeVersionNotice", () => {
  beforeEach(() => resetClaudeVersionNotices());

  it("shows one notice for a mismatched version, even across re-renders and remounts", () => {
    const notice = vi.fn();
    const first = renderHook(({ version }) => useClaudeVersionNotice(version, notice), {
      initialProps: { version: null as string | null },
    });
    expect(notice).not.toHaveBeenCalled();
    first.rerender({ version: "2.1.300 (Claude Code)" });
    first.rerender({ version: "2.1.300 (Claude Code)" });
    first.unmount();
    renderHook(() => useClaudeVersionNotice("2.1.300 (Claude Code)", notice));
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0][0]).toBe("Claude Code version not tested");
    expect(notice.mock.calls[0][1]).toContain("you have 2.1.300");
  });

  it("shows a new notice when a different version is detected", () => {
    const notice = vi.fn();
    const hook = renderHook(({ version }) => useClaudeVersionNotice(version, notice), {
      initialProps: { version: "2.1.300" },
    });
    hook.rerender({ version: "2.2.0" });
    expect(notice).toHaveBeenCalledTimes(2);
  });

  it("shows nothing for the tested version or an unknown one", () => {
    const notice = vi.fn();
    const hook = renderHook(({ version }) => useClaudeVersionNotice(version, notice), {
      initialProps: { version: `${TESTED_CLAUDE_VERSION} (Claude Code)` as string | null },
    });
    hook.rerender({ version: "test" });
    hook.rerender({ version: null });
    expect(notice).not.toHaveBeenCalled();
  });
});
