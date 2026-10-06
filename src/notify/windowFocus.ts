import { useEffect, useState } from "react";

/** True when DCTerminal is the focused, visible window. */
export function isWindowFocused(doc: Document | undefined = globalThis.document): boolean {
  if (!doc) return true;
  if (doc.visibilityState === "hidden") return false;
  return typeof doc.hasFocus === "function" ? doc.hasFocus() : true;
}

/** Re-renders on window focus, blur, and visibility changes. */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => isWindowFocused());
  useEffect(() => {
    const update = () => setFocused(isWindowFocused());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return focused;
}
