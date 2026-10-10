// The repo has no @types/node; these are the only Node APIs the e2e code uses.
declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
}
declare const process: { env: Record<string, string | undefined> };
