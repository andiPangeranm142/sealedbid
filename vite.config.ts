import react from "@vitejs/plugin-react";
import HttpsProxyAgentPkg from "https-proxy-agent";
import { defineConfig } from "vite";

// https-proxy-agent v5 is CommonJS, so the class comes off the default
// export (a named ESM import fails to load in vite's config loader).
const { HttpsProxyAgent } = HttpsProxyAgentPkg;

// The public REST APIs send no CORS headers, so the browser reaches them
// through the dev (and preview) server: /lcd-testnet and /lcd-mainnet are
// forwarded to each network's REST endpoint (see REST_PROXY in src/App.tsx).
// In production, serve the app behind a proxy that does the same.
//
// Vite's proxy (http-proxy) does NOT honour the https_proxy environment
// variable: left alone it opens a direct connection, which fails in
// sandboxed networks (the proxy answers 500 with a TLS "wrong version
// number" error). When https_proxy is set, route the upstream connection
// through it explicitly. Without https_proxy this is a no-op.
const upstreamAgent = process.env.https_proxy
  ? new HttpsProxyAgent(process.env.https_proxy)
  : undefined;
const rest = (target: string) => ({
  target,
  changeOrigin: true,
  agent: upstreamAgent,
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
