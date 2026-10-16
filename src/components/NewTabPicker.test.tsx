// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { NewTabPicker } from "./NewTabPicker";
import type { NewTabContext } from "../newTab";

const context: NewTabContext = {
  folder: "/Users/me/code/app",
  recents: ["/Users/me/code/api", "/Users/me/code/web"],
  home: "/Users/me",
};

function setup(overrides: Partial<Parameters<typeof NewTabPicker>[0]> = {}) {
  const props = {
    context,
    onClaude: vi.fn(),
    onShell: vi.fn(),
    onRole: vi.fn(),
    onDontAskAgain: vi.fn(),
    onClose: vi.fn(),
    chooseFolder: vi.fn(async () => "/Users/me/picked"),
    ...overrides,
  };
  render(<NewTabPicker {...props} />);
  const list = screen.getByRole("listbox", { name: "Open in the new tab" });
  return { props, list };
}

describe("NewTabPicker", () => {
  it("focuses the list and shows the folder on Claude and Shell rows", () => {
    const { list } = setup();
    expect(document.activeElement).toBe(list);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Claude here~/code/appC / Enter",
      "Shell here~/code/appS",
      "Role…Pick a role, provider and Terminal or ChatR",
      "api~/code/api1",
      "web~/code/web2",
      "Open folder…Choose a folder, then open Claude thereO",
    ]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("opens Claude here on C and on Enter", () => {
    const { props, list } = setup();
    fireEvent.keyDown(list, { key: "c" });
    expect(props.onClaude).toHaveBeenLastCalledWith("/Users/me/code/app");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(props.onClaude).toHaveBeenCalledTimes(2);
  });

  it("opens a shell on S and the role launcher on R", () => {
    const { props, list } = setup();
    fireEvent.keyDown(list, { key: "s" });
    expect(props.onShell).toHaveBeenCalledWith("/Users/me/code/app");
    fireEvent.keyDown(list, { key: "R" });
    expect(props.onRole).toHaveBeenCalled();
  });

  it("opens Claude in a recent project by number", () => {
    const { props, list } = setup();
    fireEvent.keyDown(list, { key: "2" });
    expect(props.onClaude).toHaveBeenCalledWith("/Users/me/code/web");
    fireEvent.keyDown(list, { key: "3" });
    expect(props.onClaude).toHaveBeenCalledTimes(1);
  });

  it("moves with the arrows and Enter picks the highlighted row", () => {
    const { props, list } = setup();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(props.onShell).toHaveBeenCalledWith("/Users/me/code/app");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[5].getAttribute("aria-selected")).toBe("true");
  });

  it("opens Claude in a chosen folder on O", async () => {
    const { props, list } = setup();
    fireEvent.keyDown(list, { key: "o" });
    await waitFor(() => expect(props.onClaude).toHaveBeenCalledWith("/Users/me/picked"));
  });

  it("does nothing when the folder dialog is cancelled, and shows a failure", async () => {
    const chooseFolder = vi.fn(async () => null as string | null);
    const { props, list } = setup({ chooseFolder });
    fireEvent.keyDown(list, { key: "o" });
    await waitFor(() => expect(chooseFolder).toHaveBeenCalled());
    expect(props.onClaude).not.toHaveBeenCalled();
    chooseFolder.mockRejectedValueOnce(new Error("dialog broke"));
    fireEvent.keyDown(list, { key: "o" });
    expect((await screen.findByRole("alert")).textContent).toContain("dialog broke");
  });

  it("ignores modified keys", () => {
    const { props, list } = setup();
    fireEvent.keyDown(list, { key: "c", metaKey: true });
    fireEvent.keyDown(list, { key: "s", ctrlKey: true });
    expect(props.onClaude).not.toHaveBeenCalled();
    expect(props.onShell).not.toHaveBeenCalled();
  });

  it("saves Don't ask again", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: /Don't ask again: always open Claude here/ }));
    expect(props.onDontAskAgain).toHaveBeenCalledWith(true);
  });

  it("closes on Escape", () => {
    const { props, list } = setup();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("disables Claude here and Shell here without a folder", () => {
    const { props, list } = setup({ context: { folder: null, recents: [], home: null } });
    expect(screen.getAllByRole("option")[0].textContent).toContain("No folder yet");
    fireEvent.keyDown(list, { key: "c" });
    fireEvent.keyDown(list, { key: "s" });
    expect(props.onClaude).not.toHaveBeenCalled();
    expect(props.onShell).not.toHaveBeenCalled();
    expect(screen.queryByText("Recent projects")).toBeNull();
  });
});
