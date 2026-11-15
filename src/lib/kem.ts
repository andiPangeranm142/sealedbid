/**
 * kem.ts - client-side ML-KEM-1024 (FIPS 203) sealing for SealedBid.
 *
 * Runs identically in the browser and in Node (scripts): pure-JS crypto
 * from @noble/post-quantum (ML-KEM) and @noble/ciphers (AES-256-GCM). No
 * native modules, no network calls.
 *
 * What this module does — and what it deliberately does NOT do:
 * - It generates ML-KEM-1024 keypairs, encapsulates a shared secret to a
 *   public key, and seals a bid payload ({amount, salt}) with AES-256-GCM
 *   under that shared secret. All of that happens CLIENT-SIDE.
 * - It never talks to the chain. Publishing a public key in the x/pqc KEM
 *   registry is a native-lane message (scripts/register-kem.ts); reading
 *   one back is fetchKemKey from @qorechain/sdk. The EVM contract only
 *   stores ciphertexts and commitments and enforces the auction rules.
 *
 * Sizes (FIPS 203, ML-KEM-1024): public key 1568 bytes, ciphertext 1568
 * bytes, secret key 3168 bytes, shared secret 32 bytes.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { encodePacked, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";

/** ML-KEM-1024 public (encapsulation) key size, in bytes. */
export const KEM_PUBLIC_KEY_SIZE = 1568;
/** ML-KEM-1024 ciphertext size, in bytes. */
export const KEM_CIPHERTEXT_SIZE = 1568;
/** ML-KEM-1024 secret (decapsulation) key size, in bytes. */
export const KEM_SECRET_KEY_SIZE = 3168;
/** ML-KEM-1024 shared secret size, in bytes (also the AES-256 key size). */
export const SHARED_SECRET_SIZE = 32;
/** AES-GCM nonce size, in bytes. */
export const GCM_NONCE_SIZE = 12;

/** The plaintext sealed inside a bid: the amount and the reveal salt. */
export interface BidPayload {
  /** Bid amount, in uqor units, as a decimal string. */
  amount: string;
  /** Random 32-byte salt (0x hex), used in the on-chain commitment. */
  salt: Hex;
}

/** A sealed bid, ready to submit on-chain. */
export interface SealedBid {
  /** ML-KEM-1024 ciphertext (1568 bytes). */
  kemCiphertext: Uint8Array;
  /** AES-256-GCM blob: 12-byte nonce || ciphertext || 16-byte tag. */
  sealedBid: Uint8Array;
}

/** An ML-KEM-1024 keypair. */
export interface KemKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Generate a fresh ML-KEM-1024 keypair.
 * @param seed Optional 64-byte deterministic seed (tests only). Without it,
 *             the keypair comes from the platform CSPRNG.
 */
export function generateKemKeypair(seed?: Uint8Array): KemKeypair {
  const kp = seed ? ml_kem1024.keygen(seed) : ml_kem1024.keygen();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** keccak256 of a public key — the binding stored on-chain per auction. */
export function kemPublicKeyHash(publicKey: Uint8Array): Hex {
  return keccak256(toHex(publicKey));
}

/** A fresh random 32-byte salt (0x hex), from the platform CSPRNG. */
export function randomSalt(): Hex {
  const buf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buf);
  return toHex(buf);
}

/**
 * The on-chain commitment for a bid. Must match the contract exactly:
 * keccak256(abi.encodePacked(amount, salt, bidder)).
 */
export function computeCommitment(amount: bigint, salt: Hex, bidder: Address): Hex {
  return keccak256(
    encodePacked(["uint256", "bytes32", "address"], [amount, salt, bidder]),
  );
}

function encodePayload(payload: BidPayload): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ amount: payload.amount, salt: payload.salt }),
  );
}

function decodePayload(bytes: Uint8Array): BidPayload {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as BidPayload).amount !== "string" ||
    typeof (parsed as BidPayload).salt !== "string"
  ) {
    throw new Error("Sealed bid payload is malformed");
  }
  return parsed as BidPayload;
}

/**
 * Seal a bid to an auctioneer's ML-KEM-1024 public key: encapsulate a fresh
 * shared secret, then AES-256-GCM-encrypt the payload under it. The shared
 * secret itself is never stored or transmitted — only the 1568-byte KEM
 * ciphertext that lets the secret-key holder re-derive it.
 */
export function sealBid(publicKey: Uint8Array, payload: BidPayload): SealedBid {
  if (publicKey.length !== KEM_PUBLIC_KEY_SIZE) {
    throw new Error(`ML-KEM-1024 public key must be ${KEM_PUBLIC_KEY_SIZE} bytes, got ${publicKey.length}`);
  }
  const { cipherText, sharedSecret } = ml_kem1024.encapsulate(publicKey);
  const nonce = new Uint8Array(GCM_NONCE_SIZE);
  globalThis.crypto.getRandomValues(nonce);
  const cipher = gcm(sharedSecret, nonce);
  const encrypted = cipher.encrypt(encodePayload(payload));
  const sealedBid = new Uint8Array(GCM_NONCE_SIZE + encrypted.length);
  sealedBid.set(nonce, 0);
  sealedBid.set(encrypted, GCM_NONCE_SIZE);
  return { kemCiphertext: cipherText, sealedBid };
}

/**
 * Open a sealed bid with the auctioneer's ML-KEM-1024 secret key.
 * Throws if the ciphertext is the wrong size, the blob is too short, or
 * the GCM authentication tag does not verify (tampered blob or wrong key).
 */
export function unsealBid(
  secretKey: Uint8Array,
  kemCiphertext: Uint8Array,
  sealedBid: Uint8Array,
): BidPayload {
  if (secretKey.length !== KEM_SECRET_KEY_SIZE) {
    throw new Error(`ML-KEM-1024 secret key must be ${KEM_SECRET_KEY_SIZE} bytes, got ${secretKey.length}`);
  }
  if (kemCiphertext.length !== KEM_CIPHERTEXT_SIZE) {
    throw new Error(`ML-KEM-1024 ciphertext must be ${KEM_CIPHERTEXT_SIZE} bytes, got ${kemCiphertext.length}`);
  }
  if (sealedBid.length <= GCM_NONCE_SIZE + 16) {
    throw new Error("Sealed bid blob is too short to hold a nonce and a GCM tag");
  }
  const sharedSecret = ml_kem1024.decapsulate(kemCiphertext, secretKey);
  const nonce = sealedBid.subarray(0, GCM_NONCE_SIZE);
  const encrypted = sealedBid.subarray(GCM_NONCE_SIZE);
  const cipher = gcm(sharedSecret, nonce);
  return decodePayload(cipher.decrypt(encrypted));
}

/** Hex helpers (viem-backed, so bytes <-> 0x strings stay consistent). */
export const bytesToHex = (bytes: Uint8Array): Hex => toHex(bytes);
export const hexToBytesSafe = (hex: Hex): Uint8Array => hexToBytes(hex);
