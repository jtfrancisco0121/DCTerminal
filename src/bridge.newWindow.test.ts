import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenNewWindow } from "./bridge";

// Two webviews sharing one fake event plugin. Delivery follows Tauri 2.12's
// `emit_to` with a plain label (`EventTarget::AnyLabel`, manager/mod.rs
// `filter_target` and listener.rs `match_any_or_filter`): a listener
// registered with target `Any` hears it in every webview; a listener bound
// to a window/webview/webview-window label hears it only when the label
// matches.
type Target = { kind: string; label?: string };
type Listener = { webview: string; event: string; target: Target; callback: number };

function fakeTauri() {
  let current = "main";
  let nextId = 1;
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners: Listener[] = [];
  const internals = {
    metadata: {
      get currentWindow() {
        return { label: current };
      },
      get currentWebview() {
        return { label: current, windowLabel: current };
      },
    },
    transformCallback(fn: (payload: unknown) => void) {
      const id = nextId++;
      callbacks.set(id, fn);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    async invoke(cmd: string, args: { event: string; target: Target; handler: number }) {
      if (cmd === "plugin:event|listen") {
        listeners.push({ webview: current, event: args.event, target: args.target, callback: args.handler });
        return nextId++;
      }
      return null;
    },
  };
  return {
    internals,
    /** The code below runs as if inside the webview window `label`. */
    inWindow(label: string) {
      current = label;
    },
    /** Rust `app.emit_to(label, event, ())`. */
    emitTo(label: string, event: string) {
      for (const listener of listeners) {
        if (listener.event !== event) continue;
        const { kind, label: bound } = listener.target;
        const hears =
          kind === "Any" ||
          (["AnyLabel", "Window", "Webview", "WebviewWindow"].includes(kind) && bound === label);
        if (hears) callbacks.get(listener.callback)?.({ event, id: 0, payload: null });
      }
    },
  };
}

describe("listenNewWindow", () => {
  let tauri: ReturnType<typeof fakeTauri>;

  beforeEach(() => {
    tauri = fakeTauri();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: tauri.internals });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("File > New Window reaches only the window it was sent to", async () => {
    const main = vi.fn();
    const second = vi.fn();
    tauri.inWindow("main");
    await listenNewWindow(main);
    tauri.inWindow("window-2");
    await listenNewWindow(second);

    // windows.rs `request_new_window`: emit_to the focused window's label.
    tauri.emitTo("window-2", "new-window");
    expect(main).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    tauri.emitTo("main", "new-window");
    expect(main).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
