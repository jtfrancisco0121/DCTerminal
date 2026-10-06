/**
 * OS notifications through tauri-plugin-notification. Every call is
 * best-effort: a browser dev build, a denied permission, or a plugin error
 * only means no system notification. The in-app toast still shows.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let granted = false;
let asked = false;

export function resetSystemNotifyForTests(): void {
  granted = false;
  asked = false;
}

async function ensurePermission(askAgain: boolean): Promise<boolean> {
  if (granted) return true;
  if (await isPermissionGranted()) {
    granted = true;
    return true;
  }
  // Ask once per run unless the user pressed a button (askAgain).
  if (asked && !askAgain) return false;
  asked = true;
  granted = (await requestPermission()) === "granted";
  return granted;
}

export async function showSystemNotification(
  title: string,
  body: string,
  options: { askAgain?: boolean } = {},
): Promise<boolean> {
  try {
    if (!(await ensurePermission(options.askAgain ?? false))) return false;
    sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
}
