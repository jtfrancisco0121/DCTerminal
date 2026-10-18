import { useCallback, useEffect, useRef, useState } from "react";
import { scratchLoad, scratchSave } from "./bridge";
import {
  dropUnknownLocalPads,
  loadLocalDrafts,
  LOCAL_DRAFT_KEY,
  mergeDraftFiles,
  pruneLocalDrafts,
  rememberPrompt,
  saveLocalDrafts,
  SCRATCH_DEBOUNCE_MS,
  upsertPad,
  type DraftFile,
  type DraftStorage,
} from "./scratch/pad";
import { ensureWebStorage } from "./storage/webStorage";

function browserStorage(): DraftStorage {
  // Use the returned store. On Node 25+ the global can stay undefined even
  // after a failed replace, and a direct localStorage.getItem would throw.
  const storage = ensureWebStorage().localStorage;
  return {
    read: (key) => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    write: (key, value) => {
      storage.setItem(key, value);
    },
  };
}

function diskFile(entries: { tabId: string; content: string; updatedAt: string; history: string[] }[]): DraftFile {
  const pads: DraftFile["pads"] = {};
  for (const entry of entries) {
    const updatedAt = Date.parse(entry.updatedAt);
    pads[entry.tabId] = {
      content: entry.content,
      updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
      history: entry.history ?? [],
    };
  }
  return { pads };
}

export function useScratchPads(activeTabId: string | null) {
  const [file, setFile] = useState<DraftFile>({ pads: {} });
  const [persistError, setPersistError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const fileRef = useRef(file);
  fileRef.current = file;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per pad: the `updatedAt` of the copy on disk, as far as this window
  // knows. Only pads edited since then are saved, so a window never writes
  // its stale copy of a pad another window is editing.
  const savedAt = useRef<Record<string, number>>({});

  const writeThrough = useCallback(async (next: DraftFile) => {
    const local = saveLocalDrafts(browserStorage(), next);
    if (!local.ok) {
      setPersistError(local.error ?? "could not save scratch draft");
    }
    const jobs = Object.entries(next.pads)
      .filter(([tabId, pad]) => pad.updatedAt > (savedAt.current[tabId] ?? 0))
      // A stamp Date cannot hold would throw in toISOString and stop every
      // other pad saving; skip just that pad.
      .filter(([, pad]) => !Number.isNaN(new Date(pad.updatedAt).getTime()))
      .map(([tabId, pad]) =>
        scratchSave(tabId, pad.content, pad.history, new Date(pad.updatedAt).toISOString())
          .then((outcome) => {
            // Null: a mock or an older backend, which always applies.
            if (!outcome || outcome.applied) {
              savedAt.current[tabId] = Math.max(savedAt.current[tabId] ?? 0, pad.updatedAt);
              return;
            }
            // Another window saved a newer copy: adopt it, unless this
            // window has typed again since.
            const stored = diskFile([outcome.pad]).pads[tabId];
            savedAt.current[tabId] = stored.updatedAt;
            setFile((prev) => {
              const current = prev.pads[tabId];
              if (current && current.updatedAt > stored.updatedAt) return prev;
              return { pads: { ...prev.pads, [tabId]: stored } };
            });
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            setPersistError(message);
          }),
      );
    await Promise.all(jobs);
  }, []);

  const schedule = useCallback(
    (next: DraftFile) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void writeThrough(next);
      }, SCRATCH_DEBOUNCE_MS);
    },
    [writeThrough],
  );

  // writeThrough mirrors to local storage synchronously before its first
  // await, so flush and pagehide need no separate mirror write.
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void writeThrough(fileRef.current);
  }, [writeThrough]);

  useEffect(() => {
    let cancelled = false;
    const local = loadLocalDrafts(browserStorage());
    scratchLoad()
      .then((snap) => {
        if (cancelled) return;
        const disk = diskFile(snap.pads);
        for (const [tabId, pad] of Object.entries(disk.pads)) {
          savedAt.current[tabId] = pad.updatedAt;
        }
        pruneLocalDrafts(browserStorage(), snap.knownTabIds);
        const merged = mergeDraftFiles(dropUnknownLocalPads(local, snap.knownTabIds), disk);
        // Keep edits typed before the load resolved (newer `updatedAt` wins).
        setFile((prev) => mergeDraftFiles(prev, merged));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (local) setFile(local);
        setPersistError(`Drafts on disk could not be read: ${err instanceof Error ? err.message : String(err)}`);
      });
    const onHide = () => {
      if (timer.current) clearTimeout(timer.current);
      void writeThrough(fileRef.current);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onHide);
    };
  }, [writeThrough]);

  const content = activeTabId ? (file.pads[activeTabId]?.content ?? "") : "";
  const history = activeTabId ? (file.pads[activeTabId]?.history ?? []) : [];

  const setContent = useCallback(
    (tabId: string, value: string) => {
      setFile((prev) => {
        const result = upsertPad(prev, tabId, value, Date.now());
        setTruncated(result.truncated);
        schedule(result.file);
        return result.file;
      });
    },
    [schedule],
  );

  const remember = useCallback((tabId: string, prompt: string) => {
    setFile((prev) => {
      const next = rememberPrompt(prev, tabId, prompt, Date.now());
      schedule(next);
      return next;
    });
  }, [schedule]);

  return { content, history, persistError, truncated, setContent, remember, flush };
}

export { LOCAL_DRAFT_KEY };
