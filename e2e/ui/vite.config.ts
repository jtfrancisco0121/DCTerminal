import { defineConfig, type UserConfig } from "vite";
import base from "../../vite.config.ts";

// The app's Vite config on its own port with HMR off, so a running `npm run dev`
// (ports 1420/1421) is never reused by mistake and never collides with this one.
export default defineConfig((env) => {
  const config = (typeof base === "function" ? base(env) : base) as UserConfig;
  return {
    ...config,
    root: new URL("../..", import.meta.url).pathname,
    server: { ...config.server, port: 1430, strictPort: true, host: "127.0.0.1", hmr: false },
  };
});
