import { useEffect } from "react";
import { detectPlatform, isImeEvent, matchShortcut, type Platform, type ShortcutMatch } from "./keymap";

type Options = {
  platform?: Platform;
  dialogOpen: boolean;
  promptInFlight: boolean;
  onAction: (match: ShortcutMatch) => void;
  onCancelTurn: () => void;
};

export function useAppShortcuts({
  platform,
  dialogOpen,
  promptInFlight,
  onAction,
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
      const match = matchShortcut(
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
        { platform: host, dialogOpen },
      );
      if (match) {
        event.preventDefault();
        onAction(match);
        return;
      }
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [platform, dialogOpen, promptInFlight, onAction, onCancelTurn]);
}
