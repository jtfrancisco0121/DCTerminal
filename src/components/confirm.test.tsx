// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost, confirmAction, useConfirm } from "./confirm";

function Asker({ onAnswer }: { onAnswer: (ok: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={() =>
        void confirm({
          title: "Remove account",
          message: "Remove Work?\n\nSigned-in data stays on disk.",
          confirmLabel: "Remove",
          danger: true,
        }).then(onAnswer)
      }
    >
      ask
    </button>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("useConfirm", () => {
  it("shows an alertdialog with the message and resolves true on confirm", async () => {
    const onAnswer = vi.fn();
    render(
      <>
        <Asker onAnswer={onAnswer} />
        <ConfirmHost />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove account" });
    expect(dialog.textContent).toContain("Signed-in data stays on disk.");
    const confirmButton = screen.getByRole("button", { name: "Remove" });
    expect(confirmButton.className).toContain("danger-button");
    expect(document.activeElement).toBe(confirmButton);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("resolves false on Cancel and on Escape", async () => {
    const onAnswer = vi.fn();
    render(
      <>
        <Asker onAnswer={onAnswer} />
        <ConfirmHost />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "ask" }));
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
    expect(onAnswer).toHaveBeenLastCalledWith(false);
  });

  it("queues a second question until the first is answered", async () => {
    render(<ConfirmHost />);
    const answers: boolean[] = [];
    act(() => {
      void confirmAction({ title: "One", message: "first" }).then((ok) => answers.push(ok));
      void confirmAction({ title: "Two", message: "second" }).then((ok) => answers.push(ok));
    });
    expect(await screen.findByRole("alertdialog", { name: "One" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alertdialog", { name: "Two" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(answers).toEqual([true, false]));
  });

  it("falls back to the browser prompt when no host is mounted", async () => {
    const spy = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await confirmAction({ title: "T", message: "M" })).toBe(true);
    expect(spy).toHaveBeenCalledWith("T\n\nM");
  });
});
