// The repo has no @types/node; these are the only Node APIs the e2e code uses.
declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
  /** A Buffer, which is a Uint8Array. */
  export function readFileSync(path: URL): Uint8Array;
}
declare module "node:http" {
  export type IncomingMessage = { url?: string };
  export type ServerResponse = {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body?: string): void;
  };
  export type Server = {
    listen(port: number, host: string, done: () => void): void;
    address(): { port: number } | string | null;
    close(done?: () => void): void;
  };
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}
declare const process: { env: Record<string, string | undefined>; argv: string[] };
