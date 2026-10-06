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

type Options = {
  platform?: Platform;
  dialogOpen: boolean;
  promptInFlight: boolean;
  getSurface?: () => KeySurface;
  onAction: (match: ShortcutMatch) => void;
  onTerminal?: (action: TerminalAction) => void;
  onCancelTurn: () => void;
};

export function useAppShortcuts({
  platform,
  dialogOpen,
  promptInFlight,
  getSurface,
  onAction,
  onTerminal,
  onCancelTurn,
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
          targetTag,
        },
        { platform: host, dialogOpen, surface },
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
        !dialogOpen &&
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
  }, [platform, dialogOpen, promptInFlight, getSurface, onAction, onTerminal, onCancelTurn]);
}
