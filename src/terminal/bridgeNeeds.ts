/**
 * Bridged stages' Needs you (ADR-015, D22): the PermissionRequest hook (or
 * its Notification backup) said a permission dialog is up. The mark is set
 * at once from the bridge's event, and cleared when you answer it (an
 * answer key, or its screen dialog drawn and gone), by a later log read
 * that shows the tool finished or the turn over, or when the tab's PTY
 * exits or a new one begins.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listenBridgeNeeds, type BridgeNeeds, type BridgeTag } from "../bridge";
import {
  bridgeNeedsAfterAnswer,
  bridgeNeedsAfterDialog,
  bridgeNeedsAfterRead,
  OWN_PROMPT_TOOLS,
  type BridgeNeedsMark,
} from "./claudeState";
import { subscribePtyAnswer, subscribePtyBegin, subscribePtyExit } from "./live";

type BridgedTab = { id: string; bridge?: BridgeTag | null };

/**
 * The mark `event` sets on its tab, or null when it is not for a bridged
 * stage that tab holds, asks about a tool with its own prompt, or is the
 * late Notification backup while the hook's mark is up.
 */
export function markForEvent(
  tab: BridgedTab | undefined,
  current: BridgeNeedsMark | undefined,
  event: BridgeNeeds,
  now: number,
): BridgeNeedsMark | null {
  if (!tab?.bridge || tab.bridge.runId !== event.runId || tab.bridge.stage !== event.stageKey) return null;
  if (event.tool && OWN_PROMPT_TOOLS.has(event.tool)) return null;
  if (event.source === "permission_prompt" && current) return null;
  return { tool: event.tool ?? null, at: now, key: `${event.turn}|${event.at}` };
}

type LogView = Parameters<typeof bridgeNeedsAfterRead>[1];

export function useBridgeNeeds(tabs: () => readonly BridgedTab[]) {
  const marks = useRef(new Map<string, BridgeNeedsMark>());
  const [version, setVersion] = useState(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const set = useCallback((tabId: string, mark: BridgeNeedsMark | undefined) => {
    if (marks.current.get(tabId) === mark) return;
    if (mark) marks.current.set(tabId, mark);
    else marks.current.delete(tabId);
    setVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenBridgeNeeds((event) => {
      const tab = tabsRef.current().find((item) => item.id === event.tabId);
      const mark = markForEvent(tab, tab ? marks.current.get(tab.id) : undefined, event, Date.now());
      if (tab && mark) set(tab.id, mark);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      // intentionally silent: the screen's permission dialog still shows Needs you.
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [set]);

  // An answer key sent after the hook answered its prompt: the approved
  // tool may run for minutes, and the log shows nothing until it finishes.
  useEffect(
    () => subscribePtyAnswer((id) => set(id, bridgeNeedsAfterAnswer(marks.current.get(id), Date.now()))),
    [set],
  );

  // The process that asked is gone: an exit, or a new PTY on the tab
  // (Restart, Resume) drops its mark, so the new session is not "Needs you".
  useEffect(() => {
    const offExit = subscribePtyExit((id) => set(id, undefined));
    const offBegin = subscribePtyBegin((id) => set(id, undefined));
    return () => {
      offExit();
      offBegin();
    };
  }, [set]);

  /** A session-log read that started at `readAt`. */
  const afterRead = useCallback(
    (tabId: string, log: LogView, readAt: number) => set(tabId, bridgeNeedsAfterRead(marks.current.get(tabId), log, readAt)),
    [set],
  );
  /** The screen's permission dialog was drawn (`visible`) or went away. */
  const afterDialog = useCallback(
    (tabId: string, visible: boolean) => set(tabId, bridgeNeedsAfterDialog(marks.current.get(tabId), visible)),
    [set],
  );
  const markOf = useCallback((tabId: string) => marks.current.get(tabId) ?? null, []);
  return { markOf, version, afterRead, afterDialog };
}
