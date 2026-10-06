import { useCallback, useEffect, useRef, useState } from "react";
import { scratchLoad, scratchSave } from "./bridge";
import {
  loadLocalDrafts,
  LOCAL_DRAFT_KEY,
  mergeDraftFiles,
  rememberPrompt,
  saveLocalDrafts,
  SCRATCH_DEBOUNCE_MS,
  upsertPad,
  type DraftFile,
  type DraftStorage,
} from "./scratch/pad";

const memoryStorage = new Map<string, string>();

function browserStorage(): DraftStorage {
  if (typeof localStorage === "undefined") {
    return {
      read: (key) => memoryStorage.get(key) ?? null,
      write: (key, value) => {
        memoryStorage.set(key, value);
      },
    };
  }
  return {
    read: (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write: (key, value) => {
      localStorage.setItem(key, value);
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

  const writeThrough = useCallback(async (next: DraftFile) => {
    const local = saveLocalDrafts(browserStorage(), next);
    if (!local.ok) {
      setPersistError(local.error ?? "could not save scratch draft");
    }
    const jobs = Object.entries(next.pads).map(([tabId, pad]) =>
      scratchSave(tabId, pad.content, pad.history).catch((err: unknown) => {
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

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const local = saveLocalDrafts(browserStorage(), fileRef.current);
    if (!local.ok) setPersistError(local.error ?? "could not save scratch draft");
    void writeThrough(fileRef.current);
  }, [writeThrough]);

  useEffect(() => {
    let cancelled = false;
    const local = loadLocalDrafts(browserStorage());
    scratchLoad()
      .then((snap) => {
        if (cancelled) return;
        const merged = mergeDraftFiles(local, diskFile(snap.pads));
        setFile(merged);
      })
      .catch(() => {
        if (!cancelled && local) setFile(local);
      });
    const onHide = () => {
      if (timer.current) clearTimeout(timer.current);
      const localResult = saveLocalDrafts(browserStorage(), fileRef.current);
      if (!localResult.ok) {
        setPersistError(localResult.error ?? "could not save scratch draft");
      }
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
