/**
 * threshold-open.ts - run the 2-of-3 threshold opening ceremony for an
 * auction: load any 2 of the 3 keyholder shares, reconstruct the auction's
 * ML-KEM-1024 secret key (verified against the recorded keccak256
 * commitment), then decrypt every sealed bid stored on-chain and check
 * each decrypted amount against the bidder's on-chain reveal.
 *
 * Usage (run from the repo dir; no window needed — reads only):
 *   npx tsx scripts/threshold-open.ts [auctionId] [shareA] [shareB]
 * Defaults: auction 14, shares 2 and 3.
 *
 * The share VALUES are never printed — only their indices, lengths and
 * the verification result. Testnet only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import {
  loadShares,
  openAuctionBids,
  reconstructFromShares,
} from "./threshold-ceremony.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "..");

async function main(): Promise<void> {
  const auctionId = BigInt(process.argv[2] ?? "14");
  const shareA = Number(process.argv[3] ?? "2");
  const shareB = Number(process.argv[4] ?? "3");
  const deployment = JSON.parse(
    fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address };

  console.log(`Threshold opening ceremony — auction ${auctionId}`);
  console.log(`Keyholders present: share ${shareA} + share ${shareB} (2-of-3)`);
  const stored = loadShares([shareA, shareB]);
  for (const s of stored) {
    console.log(
      `  share ${s.x}: loaded, ${(s.share.length - 2) / 2} bytes, ` +
        `commitment ${s.secretCommitment.slice(0, 18)}…`,
    );
  }
  if (stored.some((s) => s.auctionId !== Number(auctionId))) {
    throw new Error(`shares are for a different auction (expected ${auctionId})`);
  }
  const secretKey = reconstructFromShares(stored);
  console.log(
    `  reconstructed secret key: ${secretKey.length} bytes — commitment MATCHES ✓`,
  );
  console.log(`  (The full key was never stored on disk; it exists only in memory for this run.)`);

  console.log(`\nDecrypting the sealed bids stored on-chain for auction ${auctionId}…`);
  const opened = await openAuctionBids(deployment.contract, auctionId, secretKey);
  for (const o of opened) {
    console.log(
      `  ${o.bidder}: decrypted ${o.decryptedAmount} uqor — ` +
        `on-chain reveal ${o.revealedAmount} uqor — MATCH ✓`,
    );
  }
  console.log(
    `\nCeremony complete: ${opened.length} sealed bid(s) opened with 2 of 3 shares; ` +
      `every decrypted amount matches its on-chain reveal.`,
  );
}

main().catch((err: unknown) => {
  console.error("\nThreshold opening failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
