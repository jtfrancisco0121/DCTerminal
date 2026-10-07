// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
