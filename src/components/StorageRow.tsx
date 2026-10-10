import { useEffect, useState } from "react";
import { storageCleanup, storageStatus } from "../bridge";

/** 1536 -> "1.5 KB". Binary units, one decimal past KB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Settings > Data > Storage: folder size and the same sweep startup runs. */
export function StorageRow() {
  const [bytes, setBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    storageStatus()
      .then((status) => {
        if (!cancelled) setBytes(status.bytes);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cleanUp = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await storageCleanup();
      setBytes(result.bytes);
      setMessage(
        result.bytesFreed > 0 ? `Freed ${formatBytes(result.bytesFreed)}.` : "Nothing to clean up.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-subsection storage-row">
      <h4>Storage</h4>
      <p>
        App data folder: <strong>{bytes === null ? "…" : formatBytes(bytes)}</strong>
      </p>
      <p className="hint">
        Clean up removes scratch pads of tabs deleted over 30 days ago, month-old corrupt-file
        copies, and rolls the permission log past 5 MB. It also runs at startup.
      </p>
      <button type="button" onClick={() => void cleanUp()} disabled={busy}>
        {busy ? "Cleaning…" : "Clean up now"}
      </button>
      {message && (
        <p className="hint" role="status">
          {message}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
