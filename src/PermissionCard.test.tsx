// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./components/Dialog";
import { PermissionCard } from "./PermissionCard";
import type { PermissionRequestEvent } from "./bridge";

const request: PermissionRequestEvent = {
  tabId: "t1",
  sessionId: "s1",
  jsonRpcId: 9,
  title: "Run command",
  message: "ls -la",
  toolClass: "shell",
  displayKind: "execute",
  network: false,
  options: [
    { id: "allow-once", label: "Allow once" },
    { id: "reject-once", label: "Reject" },
  ],
  rawParams: "{}",
};

describe("PermissionCard", () => {
  it("maps A and R to the first allow and reject options", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <PermissionCard request={request} busy={false} onSelect={onSelect} onCancel={() => {}} />,
    );
    fireEvent.keyDown(container, { key: "a" });
    expect(onSelect).toHaveBeenCalledWith("allow-once");
    fireEvent.keyDown(container, { key: "R" });
    expect(onSelect).toHaveBeenCalledWith("reject-once");
  });

  it("dismisses on Escape", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <PermissionCard request={request} busy={false} onSelect={() => {}} onCancel={onCancel} />,
    );
    fireEvent.keyDown(container, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("ignores shortcuts while busy", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <PermissionCard request={request} busy onSelect={onSelect} onCancel={() => {}} />,
    );
    fireEvent.keyDown(container, { key: "a" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores Cmd/Ctrl/Alt+A", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <PermissionCard request={request} busy={false} onSelect={onSelect} onCancel={() => {}} />,
    );
    fireEvent.keyDown(container, { key: "a", metaKey: true });
    fireEvent.keyDown(container, { key: "a", ctrlKey: true });
    fireEvent.keyDown(container, { key: "a", altKey: true });
    fireEvent.keyDown(container, { key: "r", metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    // Shift stays allowed: Shift+A still approves.
    fireEvent.keyDown(container, { key: "A", shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("allow-once");
  });

  it("stands down while a Dialog is open, so Escape closes the dialog", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const onClose = vi.fn();
    render(
      <>
        <PermissionCard request={request} busy={false} onSelect={onSelect} onCancel={onCancel} />
        <Dialog title="Shortcuts" onClose={onClose}>
          <button type="button">inside</button>
        </Dialog>
      </>,
    );
    const inside = screen.getByRole("button", { name: "inside" });
    fireEvent.keyDown(inside, { key: "a" });
    fireEvent.keyDown(inside, { key: "Escape" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keysActive=false ignores a/r/Escape", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <PermissionCard
        request={request}
        busy={false}
        keysActive={false}
        onSelect={onSelect}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(container, { key: "a" });
    fireEvent.keyDown(container, { key: "r" });
    fireEvent.keyDown(container, { key: "Escape" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
  it("gives each card its own title id, so two panes' cards keep their own names", () => {
    render(
      <>
        <PermissionCard request={{ ...request, title: "Alpha wants rm" }} busy={false} onSelect={() => {}} onCancel={() => {}} keysActive={false} />
        <PermissionCard request={{ ...request, tabId: "t2", title: "Beta wants rm" }} busy={false} onSelect={() => {}} onCancel={() => {}} keysActive={false} />
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Alpha wants rm" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Beta wants rm" })).toBeTruthy();
    const ids = screen.getAllByRole("dialog").map((card) => card.getAttribute("aria-labelledby"));
    expect(new Set(ids).size).toBe(2);
  });
});
