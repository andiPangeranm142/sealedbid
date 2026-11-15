/**
 * register-kem.ts - manage the SealedBid auctioneer's ML-KEM-1024 keypair
 * and its publication in the chain's x/pqc KEM registry.
 *
 * The keypair file lives OUTSIDE the repo (../auctioneer-kem.json, mode
 * 600): it holds the ML-KEM secret key, which must never be committed.
 * The public key is public by design — it is published on-chain.
 *
 * Usage (testnet only; run from the repo root):
 *   npm run register-kem -- generate   create a fresh keypair (refuses to
 *                                      overwrite an existing one)
 *   npm run register-kem -- status     show the key registered on-chain
 *                                      for the deployer account
 *   npm run register-kem -- register   publish the stored public key in
 *                                      the x/pqc registry (hybrid-signed;
 *                                      needs the ML-DSA key registered
 *                                      first: `npm run window register`)
 *
 * The deployer account comes from QORE_MNEMONIC in .env.
 */
import { fetchKemKey } from "@qorechain/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toHex } from "viem";
import { generateKemKeypair, kemPublicKeyHash } from "../src/lib/kem.js";
import { REST, deriveAccount, registerKemKey } from "./qore.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
/** Keypair file: outside the repo, next to it. NEVER commit this file. */
const KEYPAIR_PATH = path.resolve(dir, "..", "..", "auctioneer-kem.json");

interface StoredKeypair {
  publicKey: `0x${string}`;
  secretKey: `0x${string}`;
  createdAt: string;
}

function loadKeypair(): StoredKeypair {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    throw new Error(
      `No keypair at ${KEYPAIR_PATH}. Run \`npm run register-kem -- generate\` first.`,
    );
  }
  return JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")) as StoredKeypair;
}

async function generate(): Promise<void> {
  if (fs.existsSync(KEYPAIR_PATH)) {
    throw new Error(
      `Keypair already exists at ${KEYPAIR_PATH}. Delete it deliberately if you really want a new one.`,
    );
  }
  const kp = generateKemKeypair();
  const stored: StoredKeypair = {
    publicKey: toHex(kp.publicKey),
    secretKey: toHex(kp.secretKey),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  console.log(`wrote ${KEYPAIR_PATH} (mode 600)`);
  console.log(`public key hash: ${kemPublicKeyHash(kp.publicKey)}`);
  console.log("Next: npm run register-kem -- register");
}

async function status(): Promise<void> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in .env");
  const acc = await deriveAccount(mnemonic);
  console.log(`account: ${acc.evm} (${acc.cosmos})`);
  const found = await fetchKemKey({ rest: REST, address: acc.cosmos });
  if (!found.found || !found.key) {
    console.log("KEM key: none registered on-chain");
    return;
  }
  console.log(`KEM key: registered (${found.key.algorithmName}, id ${found.key.algorithmId})`);
  console.log(`  height: ${found.key.registeredHeight}`);
  console.log(`  hash:   ${kemPublicKeyHash(found.key.publicKey)}`);
  if (fs.existsSync(KEYPAIR_PATH)) {
    const stored = loadKeypair();
    const localHash = kemPublicKeyHash(
      Buffer.from(stored.publicKey.slice(2), "hex"),
    );
    console.log(
      `  local keypair: ${localHash === kemPublicKeyHash(found.key.publicKey) ? "MATCHES the registered key" : "DIFFERS from the registered key"}`,
    );
  }
}

async function register(): Promise<void> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in .env");
  const acc = await deriveAccount(mnemonic);
  const stored = loadKeypair();
  const publicKey = Buffer.from(stored.publicKey.slice(2), "hex");
  console.log(`account: ${acc.evm} (${acc.cosmos})`);
  console.log(`public key hash: ${kemPublicKeyHash(publicKey)}`);
  const hash = await registerKemKey(acc, publicKey);
  console.log(`registered: ${hash}`);
  // Read it back to confirm.
  const found = await fetchKemKey({ rest: REST, address: acc.cosmos });
  if (!found.found || !found.key) throw new Error("Registration broadcast but the key is not readable back");
  const readBack = kemPublicKeyHash(found.key.publicKey);
  console.log(`read back hash: ${readBack}`);
  if (readBack !== kemPublicKeyHash(publicKey)) {
    throw new Error("Read-back hash does not match the published key");
  }
  console.log("KEM key registered and verified.");
}

const cmd = process.argv[2] ?? "status";
const run = { generate, status, register }[cmd];
if (!run) {
  console.error(`Unknown command "${cmd}". Use: generate | status | register`);
  process.exit(1);
}
run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
