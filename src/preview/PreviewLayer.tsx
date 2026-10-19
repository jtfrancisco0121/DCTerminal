/**
 * Localhost preview tabs stay loaded while they exist. An iframe reloads
 * whenever it is unmounted or moved in the DOM, so each preview tab keeps
 * one frame in a layer that never moves, and the place that shows the tab
 * (the main pane, the second pane, a grid cell) renders only a
 * `PreviewSlot`. The frame is laid over its slot; a tab with no slot on
 * screen is hidden and inert, so it cannot take focus or keys.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Register = (tabId: string, el: HTMLElement | null, previous?: HTMLElement | null) => void;

const SlotContext = createContext<Register | null>(null);

/** The slots on screen now, by tab id. */
export function usePreviewSlots(): {
  slots: Record<string, HTMLElement>;
  register: Register;
} {
  const [slots, setSlots] = useState<Record<string, HTMLElement>>({});
  const register = useCallback<Register>((tabId, el, previous) => {
    setSlots((current) => {
      if (el) return current[tabId] === el ? current : { ...current, [tabId]: el };
      // A new slot for the tab may have mounted before the old one left.
      if (!(tabId in current) || (previous && current[tabId] !== previous)) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }, []);
  return { slots, register };
}

export function PreviewSlotProvider({ register, children }: { register: Register; children: ReactNode }) {
  return <SlotContext.Provider value={register}>{children}</SlotContext.Provider>;
}

/** Where a preview tab shows. The frame itself lives in the PreviewLayer. */
export function PreviewSlot({ tabId }: { tabId: string }) {
  const register = useContext(SlotContext);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    register?.(tabId, el);
    return () => register?.(tabId, null, el);
  }, [register, tabId]);
  return <div ref={ref} className="preview-slot" data-preview-slot={tabId} />;
}

type Rect = { top: number; left: number; width: number; height: number };

const sameRect = (a: Rect | null, b: Rect) =>
  !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

/** One preview tab's frame, over its slot or hidden. */
function PreviewFrame({ slot, children }: { slot: HTMLElement | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  const measure = useCallback(() => {
    if (!slot) return;
    const box = slot.getBoundingClientRect();
    const next = { top: box.top, left: box.left, width: box.width, height: box.height };
    setRect((current) => (sameRect(current, next) ? current : next));
  }, [slot]);

  // Panes resize and move with splits, the file panel and the window. A
  // slot can also move without resizing (a bar appears above its pane): a
  // box around it then resizes, so those are watched too.
  useLayoutEffect(() => {
    if (!slot) {
      // Keys must not keep reaching a page that is no longer on screen.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && ref.current?.contains(focused)) focused.blur();
      return;
    }
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (let box: Element | null = slot; box && box !== document.documentElement; box = box.parentElement) {
      observer?.observe(box);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [slot, measure]);

  // The frame is not inside its pane, so it dims with the pane by hand, and
  // lifts while the pointer is over the pane, as the pane's content does.
  const [dim, setDim] = useState(false);
  const [paneHovered, setPaneHovered] = useState(false);
  useLayoutEffect(() => {
    const pane = slot?.closest(".split-pane");
    // A slot can arrive in a pane the pointer already rests on (no mouseenter).
    setPaneHovered(pane?.matches(":hover") ?? false);
    if (!pane) {
      setDim(false);
      return;
    }
    const read = () => setDim(pane.classList.contains("split-pane-dim"));
    read();
    const enter = () => setPaneHovered(true);
    const leave = () => setPaneHovered(false);
    pane.addEventListener("mouseenter", enter);
    pane.addEventListener("mouseleave", leave);
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(read);
    observer?.observe(pane, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer?.disconnect();
      pane.removeEventListener("mouseenter", enter);
      pane.removeEventListener("mouseleave", leave);
    };
  }, [slot]);

  const shown = slot != null;
  // Clicks and focus in the frame count as being in the pane that shows it
  // (focusing the second pane, activating a grid cell).
  const forward = (type: "mousedown" | "focusin") => {
    if (!slot) return;
    slot.dispatchEvent(
      type === "mousedown"
        ? new MouseEvent("mousedown", { bubbles: true })
        : new FocusEvent("focusin", { bubbles: true }),
    );
  };
  return (
    <div
      ref={ref}
      className="preview-layer-frame"
      data-shown={shown || undefined}
      data-dim={(shown && dim && !paneHovered) || undefined}
      aria-hidden={shown ? undefined : true}
      inert={!shown}
      style={{
        visibility: shown && rect ? "visible" : "hidden",
        ...(rect ?? { top: 0, left: 0, width: 0, height: 0 }),
      }}
      onMouseDown={() => forward("mousedown")}
      onFocus={() => forward("focusin")}
    >
      {children}
    </div>
  );
}

/** Every preview tab's frame, each kept mounted while its tab exists. */
export function PreviewLayer({
  tabIds,
  slots,
  render,
}: {
  tabIds: string[];
  slots: Record<string, HTMLElement>;
  render: (tabId: string) => ReactNode;
}) {
  return (
    <div className="preview-layer">
      {tabIds.map((id) => (
        <PreviewFrame key={id} slot={slots[id] ?? null}>
          {render(id)}
        </PreviewFrame>
      ))}
    </div>
  );
}
