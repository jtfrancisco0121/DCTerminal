// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionTerminal } from "../SessionTerminal";
import { ScratchPad } from "../components/ScratchPad";
import type { SlashCommand } from "./slashCommands";

const commands: SlashCommand[] = [
  { name: "review", description: "Review a pull request", hint: "PR number" },
  { name: "init", description: "Write CLAUDE.md", hint: null },
  { name: "release-notes", description: "Draft release notes", hint: null },
  // A blocked name that slipped into the list is still never offered.
  { name: "model", description: "Switch model", hint: null },
];

const base = {
  title: "Developer",
  cwd: "/tmp/project",
  sessionId: "s1",
  segments: [],
  promptInFlight: false,
  busy: false,
  canSendFollowUp: true,
  promptError: null,
  permissionRequest: null,
  onPermissionSelect: () => {},
  onPermissionCancel: () => {},
  onCancelTurn: () => {},
  onStop: () => {},
};

function Chat({
  onSend = () => {},
  onHistory,
  history,
}: {
  onSend?: () => void;
  onHistory?: (cursor: number) => void;
  history?: string[];
}) {
  const [text, setText] = useState("");
  return (
    <SessionTerminal
      {...base}
      followUp={text}
      onFollowUpChange={setText}
      onSendFollowUp={onSend}
      slashCommands={commands}
      history={history}
      onHistoryCursor={onHistory}
    />
  );
}

function type(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
}

const composer = () => screen.getByLabelText("Follow-up message") as HTMLTextAreaElement;
const options = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("chat composer slash menu", () => {
  it("opens on a leading slash and filters as you type", () => {
    render(<Chat />);
    expect(screen.queryByRole("listbox")).toBeNull();
    type(composer(), "/");
    expect(options()).toEqual([
      "/review PR numberReview a pull request",
      "/initWrite CLAUDE.md",
      "/release-notesDraft release notes",
    ]);
    type(composer(), "/re");
    expect(options().map((o) => o!.split(/[ A-Z]/)[0])).toEqual(["/review", "/release-notes"]);
    type(composer(), "/zzz");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not open mid-line", () => {
    render(<Chat />);
    type(composer(), "see /re");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves with arrows and inserts with Enter, tracking aria-activedescendant", () => {
    const onSend = vi.fn();
    render(<Chat onSend={onSend} />);
    type(composer(), "/");
    const input = composer();
    const first = screen.getAllByRole("option")[0];
    expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[2].id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0].id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(composer().value).toBe("/release-notes ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("inserts with Tab and with a click", () => {
    render(<Chat />);
    type(composer(), "/in");
    fireEvent.keyDown(composer(), { key: "Tab" });
    expect(composer().value).toBe("/init ");

    type(composer(), "/rev");
    fireEvent.click(screen.getByRole("option", { name: /review/ }));
    expect(composer().value).toBe("/review ");
  });

  it("closes with Esc until the text changes", () => {
    render(<Chat />);
    type(composer(), "/r");
    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    type(composer(), "/re");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("leaves Ctrl+Enter send and history arrows alone", () => {
    const onSend = vi.fn();
    const onHistory = vi.fn();
    render(<Chat onSend={onSend} onHistory={onHistory} history={["older"]} />);
    type(composer(), "/re");
    fireEvent.keyDown(composer(), { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    // Popup open: arrows move the selection, not history.
    fireEvent.keyDown(composer(), { key: "ArrowUp" });
    expect(onHistory).not.toHaveBeenCalled();
    fireEvent.keyDown(composer(), { key: "Escape" });
    composer().setSelectionRange(0, 0);
    fireEvent.keyDown(composer(), { key: "ArrowUp" });
    expect(onHistory).toHaveBeenCalled();
  });

  it("refuses to send a typed /model and points at the model picker", () => {
    const onSend = vi.fn();
    render(<Chat onSend={onSend} />);
    type(composer(), "/model opus");
    expect(screen.getByRole("alert").textContent).toContain("Use the model picker");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(composer(), { key: "Enter", ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

function Pad({ onSend = () => {} }: { onSend?: () => void }) {
  const [text, setText] = useState("");
  return (
    <ScratchPad
      content={text}
      truncated={false}
      persistError={null}
      chain={null}
      disabled={false}
      onChange={setText}
      onTransfer={() => {}}
      onSend={onSend}
      onStopChain={() => {}}
      slashCommands={commands}
    />
  );
}

describe("scratch pad slash menu", () => {
  const pad = () => screen.getByLabelText("Scratch pad editor") as HTMLTextAreaElement;

  it("completes a command at the start of a later line", () => {
    render(<Pad />);
    type(pad(), "first step\n---\n/ini");
    expect(options()).toEqual(["/initWrite CLAUDE.md"]);
    fireEvent.keyDown(pad(), { key: "Enter" });
    expect(pad().value).toBe("first step\n---\n/init ");
  });

  it("blocks a chain step that starts with /logout", () => {
    const onSend = vi.fn();
    render(<Pad onSend={onSend} />);
    type(pad(), "hello\n---\n/logout");
    expect(screen.getByRole("alert").textContent).toContain("/logout");
    fireEvent.keyDown(pad(), { key: "Enter", ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});
