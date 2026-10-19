// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearUiErrors, uiErrors } from "../uiErrors";
import { requestPaneCrash } from "./devPaneCrash";
import { PaneBoundary } from "./PaneBoundary";

let broken = new Set<string>();
let mounts = 0;

/** Throws while its name is in `broken`; counts its mounts. */
function Child({ name }: { name: string }) {
  if (broken.has(name)) throw new Error(`${name} exploded`);
  useEffect(() => {
    mounts += 1;
  }, []);
  return <p>{name} is fine</p>;
}

describe("PaneBoundary", () => {
  beforeEach(() => {
    broken = new Set();
    mounts = 0;
    clearUiErrors();
    // React reports every caught render error on the console.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a throwing child shows the fallback with the error text, and the error goes to the log", () => {
    broken.add("left");
    render(
      <PaneBoundary label="Terminal view">
        <Child name="left" />
      </PaneBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Terminal view hit an error");
    expect(alert.textContent).toContain("left exploded");
    expect(screen.getByRole("button", { name: "Reload this pane" })).toBeTruthy();
    expect(uiErrors()).toEqual([
      expect.objectContaining({ source: "Terminal view", message: "left exploded" }),
    ]);
  });

  it("a crash in one pane leaves the sibling pane mounted", () => {
    const { rerender } = render(
      <>
        <PaneBoundary label="Pane 1">
          <Child name="left" />
        </PaneBoundary>
        <PaneBoundary label="Pane 2">
          <Child name="right" />
        </PaneBoundary>
      </>,
    );
    expect(mounts).toBe(2);
    broken.add("right");
    rerender(
      <>
        <PaneBoundary label="Pane 1">
          <Child name="left" />
        </PaneBoundary>
        <PaneBoundary label="Pane 2">
          <Child name="right" />
        </PaneBoundary>
      </>,
    );
    expect(screen.getByText("left is fine")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("right exploded");
    // The sibling was not remounted.
    expect(mounts).toBe(2);
  });

  it("Reload this pane re-mounts only that subtree", () => {
    broken.add("right");
    render(
      <>
        <PaneBoundary label="Pane 1">
          <Child name="left" />
        </PaneBoundary>
        <PaneBoundary label="Pane 2">
          <Child name="right" />
        </PaneBoundary>
      </>,
    );
    expect(mounts).toBe(1);
    broken.delete("right");
    fireEvent.click(screen.getByRole("button", { name: "Reload this pane" }));
    expect(screen.getByText("right is fine")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mounts).toBe(2);
  });

  it("showing another tab in the pane clears the fallback", () => {
    broken.add("first");
    const { rerender } = render(
      <PaneBoundary label="Pane" resetKey="tab-1">
        <Child name="first" />
      </PaneBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(
      <PaneBoundary label="Pane" resetKey="tab-2">
        <Child name="second" />
      </PaneBoundary>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("second is fine")).toBeTruthy();
  });

  it("a dialog's fallback can be closed", () => {
    broken.add("changes");
    const onDismiss = vi.fn();
    render(
      <PaneBoundary label="Changes" onDismiss={onDismiss}>
        <Child name="changes" />
      </PaneBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the dev crash trigger breaks only the named pane, and Reload brings it back", () => {
    render(
      <>
        <PaneBoundary label="Pane 1" paneId="tab-1">
          <Child name="left" />
        </PaneBoundary>
        <PaneBoundary label="Pane 2" paneId="tab-2">
          <Child name="right" />
        </PaneBoundary>
      </>,
    );
    act(() => requestPaneCrash("tab-2"));
    expect(screen.getByRole("alert").textContent).toContain("Forced pane crash (dev): tab-2");
    expect(screen.getByText("left is fine")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload this pane" }));
    expect(screen.getByText("right is fine")).toBeTruthy();
  });

  it("dev builds expose the trigger on window for the Playwright spec", () => {
    expect(typeof (window as unknown as { __dctCrashPane?: unknown }).__dctCrashPane).toBe("function");
  });
});
