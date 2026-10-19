// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TabSummary } from "../bridge";
import { createPaneRenderers, type PaneDeps } from "../views/workspacePanes";
import { PreviewLayer, PreviewSlot, PreviewSlotProvider, usePreviewSlots } from "./PreviewLayer";

/** Two preview tabs; `where` picks which one has a slot on screen, and in which pane. */
function Harness({ where, onPaneDown }: { where: { a?: string; b?: string }; onPaneDown?: () => void }) {
  const { slots, register } = usePreviewSlots();
  const pane = (name: string): ReactNode => (
    <div data-testid={name} onMouseDown={onPaneDown}>
      {where.a === name && <PreviewSlot tabId="a" />}
      {where.b === name && <PreviewSlot tabId="b" />}
    </div>
  );
  return (
    <PreviewSlotProvider register={register}>
      {pane("main")}
      {pane("second")}
      <PreviewLayer
        tabIds={["a", "b"]}
        slots={slots}
        render={(id) => <iframe title={`page ${id}`} src={`http://localhost:${id === "a" ? 3000 : 4000}`} />}
      />
    </PreviewSlotProvider>
  );
}

const frameOf = (title: string) => screen.getByTitle(title).closest(".preview-layer-frame") as HTMLElement;

describe("PreviewLayer", () => {
  it("keeps a preview's iframe mounted while its tab is off screen or moves panes", () => {
    const view = render(<Harness where={{ a: "main" }} />);
    const page = screen.getByTitle("page a");
    expect(frameOf("page a").style.visibility).toBe("visible");
    // Switch to tab b: a's page stays in the DOM, hidden.
    view.rerender(<Harness where={{ b: "main" }} />);
    expect(screen.getByTitle("page a")).toBe(page);
    expect(frameOf("page a").style.visibility).toBe("hidden");
    expect(frameOf("page b").style.visibility).toBe("visible");
    // Back again, and into the second pane: still the same element.
    view.rerender(<Harness where={{ a: "second", b: "main" }} />);
    expect(screen.getByTitle("page a")).toBe(page);
    expect(frameOf("page a").style.visibility).toBe("visible");
  });

  it("makes a hidden preview inert and drops its focus", () => {
    const view = render(
      <Harness where={{ a: "main" }} />,
    );
    const frame = frameOf("page a");
    expect(frame.hasAttribute("inert")).toBe(false);
    const field = document.createElement("input");
    frame.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    view.rerender(<Harness where={{}} />);
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).not.toBe(field);
  });

  it("passes a click in the page's frame on to the pane that shows it", () => {
    const onPaneDown = vi.fn();
    render(<Harness where={{ a: "second" }} onPaneDown={onPaneDown} />);
    fireEvent.mouseDown(frameOf("page a"));
    expect(onPaneDown).toHaveBeenCalledTimes(1);
  });

  it("forgets a slot that leaves after its replacement arrived", () => {
    function Swap() {
      const { slots, register } = usePreviewSlots();
      const [second, setSecond] = useState(false);
      return (
        <PreviewSlotProvider register={register}>
          {/* Different keys: the new slot mounts in the same commit the old one leaves. */}
          <div key={second ? "two" : "one"}>
            <PreviewSlot tabId="a" />
          </div>
          <button type="button" onClick={() => setSecond(true)}>
            move
          </button>
          <PreviewLayer tabIds={["a"]} slots={slots} render={() => <iframe title="page a" />} />
        </PreviewSlotProvider>
      );
    }
    render(<Swap />);
    act(() => screen.getByRole("button", { name: "move" }).click());
    expect(frameOf("page a").style.visibility).toBe("visible");
  });
});

describe("preview dimming", () => {
  function InPane({ paneClass }: { paneClass: string }) {
    const { slots, register } = usePreviewSlots();
    return (
      <PreviewSlotProvider register={register}>
        <div className={paneClass}>
          <PreviewSlot tabId="a" />
        </div>
        <PreviewLayer tabIds={["a"]} slots={slots} render={() => <iframe title="page a" />} />
      </PreviewSlotProvider>
    );
  }

  it("dims a preview's frame while the pane that shows it is dimmed", async () => {
    const view = render(<InPane paneClass="split-pane split-pane-dim" />);
    expect(frameOf("page a").hasAttribute("data-dim")).toBe(true);
    // Focusing the pane lifts the dim, as it does for the pane's own content.
    view.rerender(<InPane paneClass="split-pane split-pane-focused" />);
    await act(async () => {});
    expect(frameOf("page a").hasAttribute("data-dim")).toBe(false);
    view.rerender(<InPane paneClass="split-pane split-pane-dim" />);
    await act(async () => {});
    expect(frameOf("page a").hasAttribute("data-dim")).toBe(true);
  });

  it("lifts the dim while the pointer is over the dimmed pane, as the pane's own content does", async () => {
    render(<InPane paneClass="split-pane split-pane-dim" />);
    const pane = document.querySelector(".split-pane")!;
    expect(frameOf("page a").hasAttribute("data-dim")).toBe(true);
    await act(async () => {
      pane.dispatchEvent(new MouseEvent("mouseenter"));
    });
    expect(frameOf("page a").hasAttribute("data-dim")).toBe(false);
    await act(async () => {
      pane.dispatchEvent(new MouseEvent("mouseleave"));
    });
    expect(frameOf("page a").hasAttribute("data-dim")).toBe(true);
  });

  it("stays lifted when its slot moves into a dimmed pane the pointer is already over", async () => {
    function TwoPanes({ inPane }: { inPane: "one" | "two" }) {
      const { slots, register } = usePreviewSlots();
      return (
        <PreviewSlotProvider register={register}>
          {(["one", "two"] as const).map((name) => (
            <div key={name} data-testid={name} className="split-pane split-pane-dim">
              {inPane === name && <PreviewSlot tabId="a" />}
            </div>
          ))}
          <PreviewLayer tabIds={["a"]} slots={slots} render={() => <iframe title="page a" />} />
        </PreviewSlotProvider>
      );
    }
    const view = render(<TwoPanes inPane="one" />);
    expect(frameOf("page a").hasAttribute("data-dim")).toBe(true);
    // The pointer rests on pane two (its strip, say): no mouseenter comes.
    const two = screen.getByTestId("two");
    const matches = two.matches.bind(two);
    vi.spyOn(two, "matches").mockImplementation((selector) => selector === ":hover" || matches(selector));
    view.rerender(<TwoPanes inPane="two" />);
    await act(async () => {});
    expect(frameOf("page a").hasAttribute("data-dim")).toBe(false);
  });
});

describe("preview measuring", () => {
  it("measures its slot when the slot or a box around it resizes, not on every render", () => {
    const observers: { callback: () => void; targets: Element[] }[] = [];
    class FakeResizeObserver {
      targets: Element[] = [];
      constructor(public callback: () => void) {
        observers.push(this);
      }
      observe(el: Element) {
        this.targets.push(el);
      }
      disconnect() {
        this.targets = [];
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    function Page({ count }: { count: number }) {
      const { slots, register } = usePreviewSlots();
      return (
        <PreviewSlotProvider register={register}>
          <div data-testid="outer">
            <span>{count}</span>
            <PreviewSlot tabId="a" />
          </div>
          <PreviewLayer tabIds={["a"]} slots={slots} render={() => <iframe title="page a" />} />
        </PreviewSlotProvider>
      );
    }
    try {
      const view = render(<Page count={0} />);
      const slot = document.querySelector('[data-preview-slot="a"]');
      const measured = () => rect.mock.contexts.filter((el) => el === slot).length;
      const first = measured();
      expect(first).toBeGreaterThan(0);
      // Renders that move nothing do not measure.
      view.rerender(<Page count={1} />);
      view.rerender(<Page count={2} />);
      expect(measured()).toBe(first);
      // A box around the slot resizing can move it without resizing it.
      const outer = screen.getByTestId("outer");
      const watching = observers.find((o) => o.targets.includes(outer) && o.targets.includes(slot!));
      expect(watching).toBeDefined();
      act(() => watching!.callback());
      expect(measured()).toBe(first + 1);
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("preview tabs outside the main pane", () => {
  it("show the preview in the second pane instead of the no-session note", () => {
    const tab = { id: "p1", kind: "preview", label: "localhost:3000", cwd: "" } as TabSummary;
    const panes = createPaneRenderers({ runtimes: {} } as unknown as PaneDeps);
    render(<>{panes.paneBody(tab, <p>This tab has no running session.</p>)}</>);
    expect(screen.queryByText("This tab has no running session.")).toBeNull();
    expect(document.querySelector('[data-preview-slot="p1"]')).toBeTruthy();
  });
});
