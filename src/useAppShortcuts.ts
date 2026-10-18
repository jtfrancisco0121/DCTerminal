import { useEffect } from "react";
import {
  detectPlatform,
  isImeEvent,
  routeKey,
  type KeySurface,
  type Platform,
  type ShortcutMatch,
  type TerminalAction,
} from "./keymap";
import { openDialogCount } from "./components/Dialog";

type Options = {
  platform?: Platform;
  dialogOpen: boolean;
  promptInFlight: boolean;
  getSurface?: () => KeySurface;
  onAction: (match: ShortcutMatch) => void;
  onTerminal?: (action: TerminalAction) => void;
  onCancelTurn: () => void;
  /** Return true when Escape in the pad should move focus instead of cancelling. */
  onPadEscape?: () => boolean;
};

export function useAppShortcuts({
  platform,
  dialogOpen,
  promptInFlight,
  getSurface,
  onAction,
  onTerminal,
  onCancelTurn,
  onPadEscape,
}: Options) {
  useEffect(() => {
    const host = platform ?? detectPlatform(
      typeof navigator === "undefined" ? "" : navigator.platform,
    );
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const targetTag = target?.tagName;
      if (isImeEvent({
        code: event.code,
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      })) {
        return;
      }
      // A Dialog on screen owns Escape: only the top one closes, and it asks first.
      if (event.key === "Escape" && openDialogCount() > 0) return;
      // Popovers such as the model picker close themselves on Escape.
      if (event.key === "Escape" && target?.closest?.("[data-own-escape]")) return;
      const surface = getSurface?.() ?? "chat";
      const routed = routeKey(
        {
          code: event.code,
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
          altGraph: event.getModifierState?.("AltGraph"),
          targetTag,
        },
        { platform: host, dialogOpen: dialogOpen || openDialogCount() > 0, surface },
      );
      if (routed.kind === "app") {
        event.preventDefault();
        event.stopPropagation();
        onAction(routed.match);
        return;
      }
      if (routed.kind === "terminal") {
        event.preventDefault();
        event.stopPropagation();
        onTerminal?.(routed.action);
        return;
      }
      if (routed.kind === "shell") return;
      if (
        event.key === "Escape" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        target?.closest(".scratch-pad") &&
        onPadEscape?.()
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // A permission card that answered this Escape marks it handled.
      if (
        !dialogOpen &&
        !event.defaultPrevented &&
        event.key === "Escape" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        promptInFlight
      ) {
        event.preventDefault();
        onCancelTurn();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    platform,
    dialogOpen,
    promptInFlight,
    getSurface,
    onAction,
    onTerminal,
    onCancelTurn,
    onPadEscape,
  ]);
}
