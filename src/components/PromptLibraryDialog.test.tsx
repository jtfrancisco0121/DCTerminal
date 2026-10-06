// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PromptLibrary } from "../bridge";
import { PromptLibraryDialog } from "./PromptLibraryDialog";

const library: PromptLibrary = {
  path: "/Users/jt/Library/Application Support/com.jtfrancisco.dcterminal/prompts.json",
  prompts: [
    {
      id: "p_plan",
      name: "Plan first",
      body: "Write a step-by-step plan before editing.",
      createdAt: "2026-10-06T00:00:00Z",
      updatedAt: "2026-10-06T00:00:00Z",
      lastUsedAt: null,
    },
    {
      id: "p_review",
      name: "Review diff",
      body: "Review the diff. List risks and missing tests.",
      createdAt: "2026-10-06T00:00:00Z",
      updatedAt: "2026-10-06T00:00:00Z",
      lastUsedAt: null,
    },
  ],
  recent: [
    { text: "fix the login bug\nthen run tests", sentAt: "2026-10-06T09:00:00Z", source: "chat" },
    { text: "npm run check", sentAt: "2026-10-06T08:00:00Z", source: "terminal" },
  ],
};

const noop = async () => {};

describe("PromptLibraryDialog", () => {
  it("filters saved prompts and inserts the chosen one", async () => {
    const onInsert = vi.fn();
    render(
      <PromptLibraryDialog
        library={library}
        canInsert
        onInsert={onInsert}
        onSave={noop}
        onDelete={noop}
        onClearRecent={noop}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Prompt library" });
    expect(dialog.textContent).toContain("prompts.json");
    const filter = within(dialog).getByRole("searchbox", { name: "Filter prompts" });
    expect(document.activeElement).toBe(filter);
    const list = within(dialog).getByRole("listbox", { name: "Saved prompts" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);

    fireEvent.change(filter, { target: { value: "risks" } });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    expect(within(dialog).getByLabelText("Prompt preview").textContent).toContain(
      "List risks and missing tests.",
    );
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onInsert).toHaveBeenLastCalledWith(
      "Review the diff. List risks and missing tests.",
      "p_review",
    );

    fireEvent.change(filter, { target: { value: "" } });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "ArrowUp" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert into scratch pad" }));
    expect(onInsert).toHaveBeenLastCalledWith("Write a step-by-step plan before editing.", "p_plan");
  });

  it("lists recent sends, inserts one, and saves one as a named prompt", async () => {
    const onInsert = vi.fn();
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('A prompt named "Fix the login bug" already exists.'))
      .mockResolvedValueOnce(undefined);
    render(
      <PromptLibraryDialog
        library={library}
        canInsert
        onInsert={onInsert}
        onSave={onSave}
        onDelete={noop}
        onClearRecent={noop}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Recent sends/ }));
    const list = screen.getByRole("listbox", { name: "Recent sends" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    fireEvent.click(within(list).getAllByRole("option")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Insert into scratch pad" }));
    expect(onInsert).toHaveBeenLastCalledWith("npm run check", null);

    fireEvent.click(within(list).getAllByRole("option")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save as prompt…" }));
    const name = screen.getByRole("textbox", { name: "Prompt name" }) as HTMLInputElement;
    expect(name.value).toBe("fix the login bug");
    expect((screen.getByRole("textbox", { name: "Prompt text" }) as HTMLTextAreaElement).value).toBe(
      "fix the login bug\nthen run tests",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    fireEvent.change(name, { target: { value: "Login fix" } });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith(null, "Login fix", "fix the login bug\nthen run tests"),
    );
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Prompt name" })).toBeNull());
  });

  it("opens straight into the save form for the scratch pad, and edits or deletes saved prompts", async () => {
    const onSave = vi.fn(async () => {});
    const onDelete = vi.fn(async () => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { unmount } = render(
      <PromptLibraryDialog
        library={library}
        canInsert
        saveDraft="Summarize the repo"
        onInsert={vi.fn()}
        onSave={onSave}
        onDelete={onDelete}
        onClearRecent={noop}
        onClose={() => {}}
      />,
    );
    const name = screen.getByRole("textbox", { name: "Prompt name" });
    expect(document.activeElement).toBe(name);
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null, "Summarize the repo", "Summarize the repo"));
    unmount();

    render(
      <PromptLibraryDialog
        library={library}
        canInsert={false}
        onInsert={vi.fn()}
        onSave={onSave}
        onDelete={onDelete}
        onClearRecent={noop}
        onClose={() => {}}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Insert into scratch pad" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt text" }), {
      target: { value: "Plan, then wait for OK." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save prompt" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith("p_plan", "Plan first", "Plan, then wait for OK."),
    );
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Prompt name" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("p_plan"));
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("closes on Escape, and Escape in the form only cancels the form", () => {
    const onClose = vi.fn();
    render(
      <PromptLibraryDialog
        library={library}
        canInsert
        saveDraft="draft"
        onInsert={vi.fn()}
        onSave={noop}
        onDelete={noop}
        onClearRecent={noop}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt name" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Prompt name" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Filter prompts" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
