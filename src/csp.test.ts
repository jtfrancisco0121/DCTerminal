import { beforeAll, describe, expect, it } from "vitest";

// Guards the content security policy in tauri.conf.json. Each case names what
// would break (or what would open up) if the directive drifted.
// Approach adapted from better-agentic-ide's scripts/csp.test.ts
// (MIT, © Alvin Reyes).

type Security = {
  csp: string;
  devCsp: string;
  dangerousDisableAssetCspModification?: string[] | boolean;
};

let security: Security;
beforeAll(async () => {
  // @ts-expect-error type error without @types/node package
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ) as string;
  security = JSON.parse(text).app.security;
});

function directive(csp: string, name: string): string[] {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.split(/\s+/)[0] === name);
  return found ? found.split(/\s+/).slice(1) : [];
}

describe.each(["csp", "devCsp"] as const)("content security policy (%s)", (key) => {
  const get = (name: string) => directive(security[key], name);

  it("is set", () => {
    expect(typeof security[key]).toBe("string");
    expect(get("default-src")).toEqual(["'self'"]);
  });

  it("loads scripts only from the app and never allows eval", () => {
    expect(get("script-src")).toEqual(["'self'"]);
    expect(security[key]).not.toContain("'unsafe-eval'");
    expect(security[key]).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("keeps inline styles working for React, xterm and Mermaid", () => {
    expect(get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("reaches Tauri IPC", () => {
    expect(get("connect-src")).toEqual(
      expect.arrayContaining(["'self'", "ipc:", "http://ipc.localhost"]),
    );
  });

  it("shows pasted images and bundled fonts", () => {
    expect(get("img-src")).toEqual(expect.arrayContaining(["'self'", "data:", "blob:"]));
    expect(get("font-src")).toEqual(["'self'", "data:"]);
  });

  it("frames only local preview servers", () => {
    expect(get("frame-src")).toEqual(["http://localhost:*", "http://127.0.0.1:*"]);
  });

  it("blocks plugins, base rewrites and form posts", () => {
    expect(get("object-src")).toEqual(["'none'"]);
    expect(get("base-uri")).toEqual(["'self'"]);
    expect(get("form-action")).toEqual(["'none'"]);
  });
});

describe("content security policy extras", () => {
  it("only the dev policy talks to the Vite dev server and its HMR socket", () => {
    const dev = directive(security.devCsp, "connect-src");
    expect(dev).toEqual(
      expect.arrayContaining(["ws://127.0.0.1:1421", "http://127.0.0.1:1420"]),
    );
    expect(security.csp).not.toContain("1420");
    expect(security.csp).not.toContain("1421");
  });

  it("stops Tauri adding style hashes, which would switch off 'unsafe-inline'", () => {
    expect(security.dangerousDisableAssetCspModification).toEqual(["style-src"]);
  });
});
