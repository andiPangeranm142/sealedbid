import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The public REST APIs send no CORS headers, so the browser reaches them
// through the dev (and preview) server: /lcd-testnet and /lcd-mainnet are
// forwarded to each network's REST endpoint (see REST_PROXY in src/App.tsx).
// In production, serve the app behind a proxy that does the same.
const rest = (target: string) => ({
  target,
  changeOrigin: true,
  rewrite: (p: string) => p.replace(/^\/lcd-(testnet|mainnet)/, ""),
});
const proxy = {
  "/lcd-testnet": rest("https://api-testnet.qore.host"),
  "/lcd-mainnet": rest("https://api.qore.host"),
};

export default defineConfig({
  plugins: [react()],
  // The live demo is served from the /sealedbid/ subpath on GitHub
  // Pages — WITHOUT this base, a plain `npm run build` emits root-absolute
  // asset URLs (/assets/...) that 404 on the live site. (A rebuild on
  // 15 Nov 2026 without the base broke the demo this way; the base is now
  // part of the config so it cannot happen again.)
  base: "/sealedbid/",
  server: { port: 5173, proxy },
  preview: { proxy },
});
