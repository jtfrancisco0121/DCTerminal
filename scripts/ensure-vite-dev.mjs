/**
 * Tauri `beforeDevCommand`: start Vite only if :1420 is free.
 * Lets you keep `npm run dev` running and restart `tauri dev` without port conflicts.
 */
import { spawn } from "node:child_process";
import net from "node:net";

const PORT = 1420;
const HOST = "127.0.0.1";

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: HOST });
    socket.setTimeout(400);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

if (await isPortOpen(PORT)) {
  console.log(`[dev] Vite already listening on http://${HOST}:${PORT} — reusing`);
  process.exit(0);
}

console.log(`[dev] Starting Vite on http://${HOST}:${PORT}`);
const child = spawn("npm run dev", {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
