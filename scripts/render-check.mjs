/**
 * render-check.mjs - verify the built demo renders without errors.
 *
 * Usage: `node scripts/render-check.mjs [url] [screenshot]`. Defaults to
 * the live GitHub Pages demo. Pass a local preview URL to check a local
 * build instead (`npm run build`, then `npx vite preview --port 4173`).
 *
 * Exits non-zero if the page shows a fatal error, if any console error or
 * page error occurs, or if the expected content is missing. Writes a
 * screenshot to /tmp/sb-render.png by default.
 *
 * Playwright is not a dependency of this repo: it is resolved from the
 * shared install at ~/workspace/codegeist/video-recorder/node_modules
 * via createRequire (NODE_PATH does not work for ESM imports).
 *
 * Chromium cannot use the VM's egress proxy directly (it resolves only to
 * an IPv6 address, and the proxy MITM-signs TLS with its own CA), so the
 * script runs the same localhost TCP forwarder the video-recorder uses
 * (127.0.0.1:3133 -> proxy IPv6:3128) and launches Chromium through it
 * with ignoreHTTPSErrors. Without this, the app's RPC reads fail with
 * ERR_TUNNEL_CONNECTION_FAILED and the live auction list stays empty.
 */
import { createRequire } from "node:module";
import net from "node:net";
import dns from "node:dns/promises";

const require = createRequire("/home/hatch/workspace/codegeist/video-recorder/package.json");
const { chromium } = require("playwright");

const FORWARDER_PORT = 3133;

async function startForwarder(localPort = FORWARDER_PORT) {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || "";
  const u = new URL(raw);
  const target = await dns.lookup(u.hostname, { family: 6 });
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target.address, port: Number(u.port) || 3128 });
    client.pipe(upstream);
    upstream.pipe(client);
    const onErr = () => { client.destroy(); upstream.destroy(); };
    client.on("error", onErr);
    upstream.on("error", onErr);
  });
  await new Promise((resolve, reject) => {
    server.listen(localPort, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  return server;
}

const url = process.argv[2] ?? "https://andipangeranm142.github.io/sealedbid/";
const screenshotPath = process.argv[3] ?? "/tmp/sb-render.png";

const forwarder = await startForwarder();
const browser = await chromium.launch({
  proxy: { server: `http://127.0.0.1:${FORWARDER_PORT}`, bypass: "localhost,127.0.0.1" },
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: true, // egress proxy MITM-signs TLS (see header)
});
const page = await context.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("requestfailed", (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText ?? ""}`));

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
// The auction list is a live on-chain read; wait for the drill auction
// (id 13, open until 20 Nov 2026) to appear before asserting.
await page.waitForFunction(
  () => document.body.innerText.includes("Q-Day Drill lot"),
  { timeout: 60000 },
);
await page.waitForTimeout(3000);
await page.screenshot({ path: screenshotPath, fullPage: true });

const text = await page.evaluate(() => document.body.innerText);
const checks = {
  "title SealedBid": text.includes("SealedBid"),
  "contract address": text.includes("0xefffcd16d4977a3e58340aeee20b10b2e723c585"),
  // Live on-chain read: auction 13 (Q-Day Drill lot) must render.
  "live auction 13 (Q-Day Drill lot)": text.includes("Q-Day Drill lot"),
  // Auctions 0/5/7/8/9/11 all revealed a 2,500,000 uqor winning bid.
  "live highest revealed (2500000 uqor)": text.includes("2500000 uqor"),
  // The create-auction form and the auctioneer's "Decrypt (local)" button
  // only render for a connected wallet (and, for decrypt, the auctioneer's
  // key holder), so an anonymous visit must show the connect prompt instead.
  "connect prompt (anonymous visitor)": text.includes("Connect a wallet to create auctions, bid, and reveal."),
  "auctions heading": text.includes("Auctions"),
  "no fatal error text": !/something went wrong|failed to load|white screen/i.test(text),
};
let ok = true;
for (const [name, passed] of Object.entries(checks)) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  if (!passed) ok = false;
}
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors) console.log(`  ${e}`);
  ok = false;
} else {
  console.log("PASS no console/page/request errors");
}
console.log(`screenshot: ${screenshotPath}`);
await browser.close();
forwarder.close();
process.exit(ok ? 0 : 1);
