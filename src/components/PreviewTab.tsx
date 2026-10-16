/**
 * Localhost preview tab: a dev server on this machine in an iframe, with an
 * address field, Refresh, and Open in browser. Only http://localhost and
 * http://127.0.0.1 addresses load here; anything else is offered to the
 * browser instead.
 *
 * Adapted from Agentic IDE's BrowserTab (better-agentic-ide, MIT License,
 * © Alvin Reyes).
 */
import { useEffect, useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { setPreviewUrl } from "../bridge";
import { errorText } from "./InlineNotice";
import {
  DEFAULT_PREVIEW_URL,
  isLocalPreviewUrl,
  isWebUrl,
  previewAddress,
} from "../preview/previewUrl";

type Props = {
  tabId: string;
  /** Saved address of the tab. */
  url?: string | null;
  onNotice: (title: string, body: string) => void;
  /** The new address was saved (the tab label follows it). */
  onSaved?: () => void;
};

/** Loads here: a localhost address that is not the app itself (a dev build). */
function canFrame(address: string): boolean {
  return isLocalPreviewUrl(address, window.location.origin);
}

export function PreviewTab({ tabId, url, onNotice, onSaved }: Props) {
  const saved = url?.trim() || DEFAULT_PREVIEW_URL;
  const [input, setInput] = useState(saved);
  const [shown, setShown] = useState(saved);
  /** An address that does not load here; it is offered to the browser. */
  const [elsewhere, setElsewhere] = useState<string | null>(canFrame(saved) ? null : saved);
  /** Bumped by Refresh: a new key reloads the iframe even at the same address. */
  const [reloads, setReloads] = useState(0);

  // Another tab's saved address when the same view is reused.
  useEffect(() => {
    setInput(saved);
    setShown(saved);
    setElsewhere(canFrame(saved) ? null : saved);
  }, [tabId, saved]);

  const openInBrowser = (address: string) => {
    void openUrl(address).catch((err: unknown) =>
      onNotice("Could not open the browser", errorText(err)),
    );
  };

  const go = (event: FormEvent) => {
    event.preventDefault();
    const address = previewAddress(input);
    if (!address) return;
    if (!canFrame(address)) {
      setElsewhere(address);
      return;
    }
    setElsewhere(null);
    setInput(address);
    setShown(address);
    setReloads((n) => n + 1);
    void setPreviewUrl(tabId, address)
      .then(() => onSaved?.())
      .catch((err: unknown) => onNotice("Preview address not saved", errorText(err)));
  };

  return (
    <section className="preview-tab" aria-label="Localhost preview">
      <form className="preview-toolbar" onSubmit={go}>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setReloads((n) => n + 1)}
          disabled={elsewhere != null}
        >
          Refresh
        </button>
        <input
          className="text-input preview-address"
          aria-label="Address"
          value={input}
          spellCheck={false}
          placeholder={DEFAULT_PREVIEW_URL}
          onChange={(event) => setInput(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="submit" className="secondary-button">
          Go
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => openInBrowser(elsewhere ?? shown)}
          disabled={elsewhere != null && !isWebUrl(elsewhere)}
        >
          Open in browser
        </button>
      </form>
      {elsewhere != null ? (
        <div className="preview-elsewhere" role="status">
          <p>This address opens in your browser.</p>
          <p className="hint">The preview shows http://localhost and http://127.0.0.1 only.</p>
          {isWebUrl(elsewhere) ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => openInBrowser(elsewhere)}
            >
              Open {elsewhere}
            </button>
          ) : null}
        </div>
      ) : (
        // allow-same-origin is safe here only because the framed page is a
        // localhost dev server: its origin (http://localhost:PORT) differs
        // from the app's own (tauri://localhost / http://tauri.localhost), so
        // it still cannot reach the app's DOM, storage, or IPC. Do not widen
        // the address check without revisiting this sandbox.
        <iframe
          key={`${shown}#${reloads}`}
          className="preview-frame"
          title={`Preview of ${shown}`}
          src={shown}
          sandbox="allow-scripts allow-forms allow-same-origin"
          referrerPolicy="no-referrer"
        />
      )}
    </section>
  );
}
