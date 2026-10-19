import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test as base } from "../fixtures/tauri";

/**
 * The policy the app ships (`app.security.csp` in src-tauri/tauri.conf.json),
 * or the one in DCT_CSP_CONF, the same file the prod-csp server reads.
 */
export function productionCsp(): string {
  const conf = process.env.DCT_CSP_CONF
    ? new URL(`file://${process.env.DCT_CSP_CONF}`)
    : new URL("../../../src-tauri/tauri.conf.json", import.meta.url);
  return JSON.parse(readFileSync(conf, "utf8")).app.security.csp;
}

/** CSP violations the page reported: `securitypolicyviolation` events and console warnings. */
export class CspViolations {
  private console: string[] = [];

  constructor(private readonly page: Page) {
    page.on("console", (message) => {
      const text = message.text();
      if (/Content[- ]Security[- ]Policy|Refused to (load|execute|connect|frame|apply|evaluate)/i.test(text)) {
        this.console.push(text);
      }
    });
  }

  async install(): Promise<void> {
    await this.page.addInitScript(() => {
      const seen: string[] = [];
      (window as any).__cspViolations = seen;
      document.addEventListener("securitypolicyviolation", (event) => {
        seen.push(`${event.effectiveDirective || event.violatedDirective} blocked ${event.blockedURI || "inline"}`);
      });
    });
  }

  /** Everything reported so far; the list starts over. */
  async take(): Promise<string[]> {
    const events = await this.page.evaluate(() => {
      const seen = (window as any).__cspViolations as string[] | undefined;
      return seen ? seen.splice(0) : [];
    });
    return [...events, ...this.console.splice(0)];
  }
}

/** The tauri fixture, failing any test whose page reported a CSP violation. */
export const test = base.extend<{ csp: CspViolations }>({
  csp: [
    async ({ page }, use) => {
      const csp = new CspViolations(page);
      await csp.install();
      await use(csp);
      expect(await csp.take(), "CSP violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
