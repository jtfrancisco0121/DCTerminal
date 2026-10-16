/**
 * Localhost preview tabs load only plain-http addresses on this machine
 * (localhost or 127.0.0.1, any port). Everything else opens in the browser.
 * Mirrors `local_preview_url` in src-tauri/src/store/preview_tabs.rs.
 */

export const DEFAULT_PREVIEW_URL = "http://localhost:5173";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** What the user typed, as a URL: "localhost:3000" becomes "http://localhost:3000". */
export function previewAddress(input: string): string {
  const text = input.trim();
  if (!text) return "";
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+([/?#]|$)/.test(text);
  return hasScheme ? text : `http://${text}`;
}

/** True for http and https addresses, the only ones offered to the browser. */
export function isWebUrl(address: string): boolean {
  try {
    const { protocol } = new URL(address.trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True when the preview tab may load this address in its iframe. `appOrigin`
 * is the app's own origin: a dev build served from localhost must not frame
 * itself, since the sandbox allows same-origin.
 */
export function isLocalPreviewUrl(address: string, appOrigin?: string): boolean {
  const text = address.trim();
  if (!text || /\s/.test(text)) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.username || url.password) return false;
  if (!LOCAL_HOSTS.has(url.hostname)) return false;
  if (appOrigin && url.origin === appOrigin) return false;
  // The raw text must name the host itself, not a lookalike the parser rewrote.
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?([/?#]|$)/i.test(text);
}
