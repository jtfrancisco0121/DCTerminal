// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadNewTabContext = vi.fn();
vi.mock("./newTab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./newTab")>()),
  loadNewTabContext: (cwd: string | null) => loadNewTabContext(cwd),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { useNewTab } from "./useNewTab";

function setup(mode: string | undefined) {
  const actions = {
    mode: () => mode,
    activeCwd: () => "/w/app",
    openStartScreen: vi.fn(async () => {}),
    openRoleLauncher: vi.fn(),
    openTerminal: vi.fn(async () => {}),
    saveMode: vi.fn(),
  };
  const hook = renderHook(() => useNewTab(actions));
  return { actions, hook };
}

beforeEach(() => {
  loadNewTabContext.mockReset();
  loadNewTabContext.mockResolvedValue({ folder: "/w/app", recents: [], home: "/h" });
});

describe("useNewTab", () => {
  it("opens Claude or a shell straight away when chosen", async () => {
    const claude = setup("claude");
    await act(() => claude.hook.result.current.request());
    expect(claude.actions.openTerminal).toHaveBeenCalledWith("claude-cli", "/w/app", null);
    const shell = setup("shell");
    await act(() => shell.hook.result.current.request());
    expect(shell.actions.openTerminal).toHaveBeenCalledWith("shell", "/w/app", null);
    expect(loadNewTabContext).toHaveBeenCalledWith("/w/app");
  });

  it("keeps the start screen when chosen, or when no folder is known", async () => {
    const start = setup("start");
    await act(() => start.hook.result.current.request());
    expect(start.actions.openStartScreen).toHaveBeenCalled();
    loadNewTabContext.mockResolvedValue({ folder: null, recents: [], home: null });
    const claude = setup("claude");
    await act(() => claude.hook.result.current.request());
    expect(claude.actions.openTerminal).not.toHaveBeenCalled();
    expect(claude.actions.openStartScreen).toHaveBeenCalled();
  });

  it("asks by default and turns a launch draft into the terminal", async () => {
    const { actions, hook } = setup(undefined);
    await act(() => hook.result.current.launch("draft-1", "rocket"));
    render(<>{hook.result.current.picker}</>);
    await waitFor(() => expect(screen.getAllByText("/w/app").length).toBe(2));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "s" });
    expect(actions.openTerminal).toHaveBeenCalledWith("shell", "/w/app", "draft-1");
  });

  it("does nothing more on a launch with the start screen chosen", async () => {
    const { actions, hook } = setup("ask");
    await act(() => hook.result.current.launch("draft-1", "start"));
    expect(actions.openStartScreen).not.toHaveBeenCalled();
    expect(actions.openTerminal).not.toHaveBeenCalled();
    expect(hook.result.current.picker).toBeNull();
  });

  it("opens the role launcher from Role…, filling a launch draft", async () => {
    const { actions, hook } = setup("ask");
    await act(() => hook.result.current.request());
    const first = render(<>{hook.result.current.picker}</>);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "r" });
    expect(actions.openRoleLauncher).toHaveBeenCalledWith(null);
    expect(actions.openStartScreen).not.toHaveBeenCalled();
    first.unmount();

    await act(() => hook.result.current.launch("draft-1", "ask"));
    render(<>{hook.result.current.picker}</>);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "r" });
    expect(actions.openRoleLauncher).toHaveBeenLastCalledWith("draft-1");
  });

  it("saves Don't ask again as claude", async () => {
    const { actions, hook } = setup("ask");
    await act(() => hook.result.current.request());
    render(<>{hook.result.current.picker}</>);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(actions.saveMode).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "c" });
    expect(actions.saveMode).toHaveBeenCalledWith("claude");
    expect(actions.openTerminal).toHaveBeenCalledWith("claude-cli", "/w/app", null);
  });

  it("does not save Don't ask again when the picker is closed with Escape", async () => {
    const { actions, hook } = setup("ask");
    await act(() => hook.result.current.request());
    render(<>{hook.result.current.picker}</>);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(actions.saveMode).not.toHaveBeenCalled();
  });
});
