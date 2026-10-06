import { describe, expect, it } from "vitest";
import {
  canOpenInCursorCli,
  canResumeInApp,
  historySourceLabel,
  resumeIdForStart,
  segmentsAfterResume,
  segmentsWhileStarting,
} from "./cursorHistory";
import type { SessionUpdateEvent } from "./bridge";

const replayEvent = (text: string): SessionUpdateEvent => ({
  tabId: "tab_1",
  sessionId: "11111111-2222-3333-4444-555555555555",
  kind: "agent_message_chunk",
  textDelta: text,
  rawJson: JSON.stringify({
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  }),
});

describe("cursor history resume", () => {
  it("loads a stored ACP id only when Continue asks to resume it", () => {
    const stored = "11111111-2222-3333-4444-555555555555";
    expect(
      resumeIdForStart({
        storedSessionId: stored,
        resumeStored: true,
      }),
    ).toBe(stored);
    expect(
      resumeIdForStart({
        storedSessionId: stored,
      }),
    ).toBeNull();
    expect(
      resumeIdForStart({
        storedSessionId: stored,
        resumeStored: true,
        forceResend: true,
      }),
    ).toBeNull();
    expect(
      resumeIdForStart({
        explicitSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        storedSessionId: stored,
      }),
    ).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("labels ACP sessions and CLI chats", () => {
    expect(historySourceLabel("acp")).toBe("ACP session");
    expect(historySourceLabel("cli")).toBe("CLI chat");
  });

  it("opens Cursor CLI only for chats, and resumes ACP sessions in the app", () => {
    expect(canOpenInCursorCli("cli")).toBe(true);
    expect(canOpenInCursorCli("acp")).toBe(false);
    expect(canResumeInApp("acp")).toBe(true);
    expect(canResumeInApp("cli")).toBe(false);
  });

  it("does not paste saved scrollback while session/load is starting", () => {
    const segments = segmentsWhileStarting({
      continuing: true,
      sessionId: "11111111-2222-3333-4444-555555555555",
      savedTranscript: "old local scrollback",
      existing: [],
    });
    expect(segments.map((segment) => segment.text).join("\n")).not.toContain(
      "old local scrollback",
    );
    expect(segments[0]?.text).toContain("session/load");
  });

  it("shows replayed ACP text instead of the local transcript", () => {
    const segments = segmentsAfterResume({
      segments: segmentsWhileStarting({
        continuing: true,
        sessionId: "11111111-2222-3333-4444-555555555555",
        savedTranscript: "old local scrollback",
        existing: [],
      }),
      loaded: true,
      replay: [replayEvent("from the agent")],
      replayMessageCount: 1,
      savedTranscript: "old local scrollback",
      folderWarning: null,
    });
    const text = segments.map((segment) => segment.text).join("\n");
    expect(text).toContain("from the agent");
    expect(text).not.toContain("old local scrollback");
    expect(text).not.toContain("Resuming ACP session");
  });

  it("keeps a labeled local copy when session/load replays no messages", () => {
    const segments = segmentsAfterResume({
      segments: [],
      loaded: true,
      replay: [],
      replayMessageCount: 0,
      savedTranscript: "old local scrollback",
      folderWarning: null,
    });
    const text = segments.map((segment) => segment.text).join("\n");
    expect(text).toContain("old local scrollback");
    expect(text).toContain("local copy");
  });
});
