// The repo has no @types/node; these are the only Node APIs the e2e code uses.
declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
  /** A Buffer, which is a Uint8Array. */
  export function readFileSync(path: URL): Uint8Array;
}
declare const process: { env: Record<string, string | undefined> };
