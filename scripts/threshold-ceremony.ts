/**
 * threshold-ceremony.ts - shared helpers for the 2-of-3 threshold opening
 * ceremony: share-file IO (mode 600, OUTSIDE the repo — shares are secret
 * material and must never be committed) and opening an auction's sealed
 * bids with a reconstructed key.
 *
 * The ceremony is OFF-CHAIN: the deployed contract cannot enforce it (see
 * src/lib/threshold.ts). What the ceremony proves is cryptographic: any 2
 * of the 3 shares reconstruct the auction's ML-KEM-1024 secret key, the
 * reconstruction is verified against the recorded keccak256 commitment,
 * and the reconstructed key decrypts the sealed bids that are stored
 * on-chain — the decrypted amounts must match the on-chain reveals.
 *
 * No main() here: scripts/threshold-open.ts is the CLI, and
 * scripts/threshold-auction.ts runs the ceremony as the last step of the
 * auction-14 run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, toHex, type Address, type Hex } from "viem";
import { qorechainTestnet } from "@qorechain/evm";
import type { Chain } from "viem";
const testnet = qorechainTestnet as unknown as Chain;
import { sealedBidAbi } from "../contracts/SealedBid.artifact.js";
import { unsealBid } from "../src/lib/kem.js";
import {
  reconstructSecret,
  secretCommitment,
  type KeyShare,
} from "../src/lib/threshold.js";
import { EVM_RPC } from "./qore.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "..");
/** Share files live OUTSIDE the repo, mode 600 — never committed. */
export const THRESHOLD_DIR = path.resolve(ROOT, "..", "threshold");
export const THRESHOLD_BACKUP_DIR = path.resolve(ROOT, "..", "threshold-backup");

export interface StoredShare {
  purpose: string;
  auctionId: number;
  threshold: number;
  totalShares: number;
  /** 1-based share index (the Shamir x-coordinate). */
  x: number;
  /** Share bytes as 0x hex (3168 bytes for an ML-KEM-1024 secret key). */
  share: Hex;
  /** The auction's ML-KEM-1024 public key (public). */
  publicKey: Hex;
  /** keccak256 of the full secret key (public commitment, for verification). */
  secretCommitment: Hex;
  createdAt: string;
}

export function sharePath(index: number, backup = false): string {
  return path.join(backup ? THRESHOLD_BACKUP_DIR : THRESHOLD_DIR, `share-${index}.json`);
}

/** Write one share file (mode 600) to the primary dir and the backup dir. */
export function saveShare(share: StoredShare): void {
  for (const d of [THRESHOLD_DIR, THRESHOLD_BACKUP_DIR]) {
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, `share-${share.x}.json`);
    fs.writeFileSync(p, JSON.stringify(share, null, 2) + "\n", { mode: 0o600 });
  }
}

/** Load share files by 1-based index. Throws when a file is missing. */
export function loadShares(indices: number[]): StoredShare[] {
  return indices.map((i) => {
    const p = sharePath(i);
    if (!fs.existsSync(p)) throw new Error(`share file not found: ${p}`);
    return JSON.parse(fs.readFileSync(p, "utf8")) as StoredShare;
  });
}

/**
 * Reconstruct the secret key from stored shares and verify it against the
 * recorded commitment. Returns the reconstructed key bytes.
 */
export function reconstructFromShares(stored: StoredShare[]): Uint8Array {
  if (stored.length < 2) throw new Error("need at least 2 shares to open");
  const threshold = stored[0]!.threshold;
  const commitment = stored[0]!.secretCommitment;
  for (const s of stored) {
    if (s.threshold !== threshold) throw new Error("shares disagree on the threshold");
    if (s.secretCommitment !== commitment) {
      throw new Error("shares disagree on the secret commitment — refusing to open");
    }
  }
  const shares: KeyShare[] = stored.map((s) => ({
    x: s.x,
    y: Buffer.from(s.share.slice(2), "hex"),
  }));
  const secretKey = reconstructSecret(shares, threshold);
  if (secretCommitment(secretKey) !== commitment) {
    throw new Error(
      "reconstructed key does NOT match the recorded commitment — a share is wrong or tampered",
    );
  }
  return secretKey;
}

export interface OpenedBid {
  bidder: Address;
  decryptedAmount: string;
  decryptedSalt: Hex;
  revealedAmount: string;
  revealed: boolean;
  matchesReveal: boolean;
}

/**
 * Open every sealed bid on an auction with a secret key: read the stored
 * ciphertexts from the chain, decrypt them, and compare each decrypted
 * amount against the bidder's on-chain reveal. Throws unless EVERY
 * revealed bid decrypts to exactly its revealed amount.
 */
export async function openAuctionBids(
  contract: Address,
  auctionId: bigint,
  secretKey: Uint8Array,
): Promise<OpenedBid[]> {
  const publicClient = createPublicClient({ chain: testnet, transport: http(EVM_RPC) });
  const bidders = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "getBidders", args: [auctionId],
  })) as Address[];
  const opened: OpenedBid[] = [];
  for (const bidder of bidders) {
    const stored = (await publicClient.readContract({
      address: contract, abi: sealedBidAbi, functionName: "bids", args: [auctionId, bidder],
    })) as unknown as [Hex, Hex, Hex, bigint, boolean];
    const payload = unsealBid(
      secretKey,
      Buffer.from(stored[0].slice(2), "hex"),
      Buffer.from(stored[1].slice(2), "hex"),
    );
    const matches = stored[4] && BigInt(payload.amount) === stored[3];
    opened.push({
      bidder,
      decryptedAmount: payload.amount,
      decryptedSalt: payload.salt,
      revealedAmount: stored[3].toString(),
      revealed: stored[4],
      matchesReveal: matches,
    });
    if (!matches) {
      throw new Error(
        `decrypted amount for ${bidder} (${payload.amount}) does not match the on-chain reveal ` +
          `(${stored[3]}, revealed=${stored[4]}) — the reconstructed key is wrong or the bid is corrupt`,
      );
    }
  }
  return opened;
}

/** The public key of the auction's threshold keypair, as 0x hex (for logs). */
export const publicKeyHex = (publicKey: Uint8Array): Hex => toHex(publicKey);
