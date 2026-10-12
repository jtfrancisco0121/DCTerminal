// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, openDialogCount } from "./Dialog";

function Pair({ onInnerClose, onOuterClose }: { onInnerClose: () => void; onOuterClose: () => void }) {
  return (
    <>
      <Dialog title="Outer" onClose={onOuterClose}>
        <button type="button">outer action</button>
      </Dialog>
      <Dialog title="Inner" onClose={onInnerClose}>
        <button type="button">inner action</button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("names itself from the title and is modal", () => {
    render(
      <Dialog title="Prompt library" onClose={() => {}}>
        body
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Prompt library" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("keeps the footer outside the scrolling body", () => {
    render(
      <Dialog title="T" onClose={() => {}} footer={<button type="button">Go</button>}>
        <p>content</p>
      </Dialog>,
    );
    const footer = screen.getByRole("button", { name: "Go" }).closest(".dialog-footer");
    expect(footer).toBeTruthy();
    expect(footer?.closest(".dialog-body")).toBeNull();
  });

  it("Escape closes only the top dialog", () => {
    const inner = vi.fn();
    const outer = vi.fn();
    render(<Pair onInnerClose={inner} onOuterClose={outer} />);
    expect(openDialogCount()).toBe(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("does not close on Escape from an element that owns Escape", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="T" onClose={onClose}>
        <input aria-label="popover field" data-own-escape="" />
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("popover field"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks onRequestClose first and stays open when it says no", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="T" onClose={onClose} onRequestClose={() => false}>
        body
      </Dialog>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Escape and Close while not dismissible", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="T" onClose={onClose} dismissible={false}>
        body
      </Dialog>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes on a backdrop press but not on a press inside the panel", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="T" onClose={onClose}>
        <button type="button">inside</button>
      </Dialog>,
    );
    fireEvent.mouseDown(screen.getByRole("button", { name: "inside" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus in, wraps Tab at both ends, and restores focus on close", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            opener
          </button>
          {open && (
            <Dialog
              title="T"
              onClose={() => setOpen(false)}
              footer={<button type="button">last</button>}
            >
              <button type="button">first body</button>
            </Dialog>
          )}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    fireEvent.click(opener);
    // The Close button in the header is the first focusable control.
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);

    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(openDialogCount()).toBe(0);
  });

  it("leaves a control that already took focus alone", () => {
    render(
      <Dialog title="T" onClose={() => {}}>
        <input aria-label="name" autoFocus />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("name"));
  });
});
