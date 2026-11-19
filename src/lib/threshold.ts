/**
 * threshold.ts - Shamir secret sharing (2-of-3) for the SealedBid threshold
 * opening ceremony.
 *
 * The deployed SealedBid contract cannot enforce threshold opening on-chain:
 * createAuction() takes exactly ONE ML-KEM-1024 public key, the contract
 * never decrypts anything, and there is no keyholder/threshold logic in it
 * at all. Threshold opening is therefore an OFF-CHAIN ceremony, enforced by
 * key custody — not by the contract. This module is the real cryptography
 * behind that ceremony:
 *
 *   - The auction's ML-KEM-1024 secret key (3168 bytes) is split with
 *     Shamir's scheme over GF(2^8) into 3 shares; any 2 reconstruct it.
 *   - One share alone reveals NOTHING about the secret: for every possible
 *     secret there is a second share consistent with the one share held
 *     (information-theoretic security — see test/threshold.test.ts).
 *   - Reconstruction is verified against a keccak256 commitment of the
 *     secret key, recorded when the shares were created. A tampered share
 *     reconstructs to a key whose commitment does not match, and any bid
 *     opened with it fails AES-GCM authentication anyway.
 *
 * What this does NOT do: it does not stop a keyholder who holds the FULL
 * secret key from decrypting alone. For auction 14 the full secret key was
 * never written to disk — the keypair was generated in memory, split, and
 * only the 3 shares were persisted — so no single party holds it. See
 * docs/threshold-ceremony.md and the README's threshold section.
 *
 * Pure JS, no network calls; runs in the browser and in Node.
 */
import { keccak256, toHex } from "viem";

/** One Shamir share: the x-coordinate and the y-values (one per secret byte). */
export interface KeyShare {
  /** Share index, 1..255. Must be non-zero and distinct across shares. */
  x: number;
  /** Share bytes, same length as the secret. */
  y: Uint8Array;
}

/** The irreducible polynomial for GF(2^8): x^8 + x^4 + x^3 + x + 1 (AES field). */
const GF_POLY = 0x11b;
/** Generator of the multiplicative group (3 has order 255 in this field; 2 does not). */
const GF_GENERATOR = 3;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // Multiply by the generator (3 = x + 1): x*3 = (x<<1) ^ x, reduced mod GF_POLY.
    let x2 = x << 1;
    if (x2 & 0x100) x2 ^= GF_POLY;
    x = x2 ^ x;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

/** GF(2^8) multiplication. Exported for tests. */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** GF(2^8) division (b must be non-zero). Exported for tests. */
export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("GF(2^8) division by zero");
  if (a === 0) return 0;
  return EXP[LOG[a] - LOG[b] + 255];
}

/** GF(2^8) multiplicative inverse (a must be non-zero). Exported for tests. */
export function gfInv(a: number): number {
  if (a === 0) throw new Error("GF(2^8) inverse of zero does not exist");
  return EXP[255 - LOG[a]];
}

/** Random bytes from the platform CSPRNG. */
function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

/**
 * Split a secret into `totalShares` shares, any `threshold` of which
 * reconstruct it. Each secret byte gets its own random polynomial of degree
 * threshold-1 with the secret byte as the constant term; share i evaluates
 * every polynomial at x = i.
 *
 * @throws when threshold < 2, threshold > totalShares, totalShares > 255,
 *         or the secret is empty.
 */
export function splitSecret(
  secret: Uint8Array,
  threshold: number,
  totalShares: number,
): KeyShare[] {
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new Error(`threshold must be an integer >= 2, got ${threshold}`);
  }
  if (!Number.isInteger(totalShares) || totalShares < threshold) {
    throw new Error(`totalShares (${totalShares}) must be >= threshold (${threshold})`);
  }
  if (totalShares > 255) {
    throw new Error("totalShares must be <= 255 (x-coordinates live in GF(2^8))");
  }
  if (secret.length === 0) throw new Error("cannot split an empty secret");

  // Random coefficients: coefficients[k][byte] is the x^k coefficient of
  // the polynomial for that secret byte (k = 1..threshold-1).
  const coefficients: Uint8Array[] = [];
  for (let k = 1; k < threshold; k++) coefficients.push(randomBytes(secret.length));

  const shares: KeyShare[] = [];
  for (let x = 1; x <= totalShares; x++) {
    const y = new Uint8Array(secret.length);
    for (let i = 0; i < secret.length; i++) {
      // Horner evaluation: y = s + c1*x + c2*x^2 + ... (addition is XOR).
      let acc = 0;
      for (let k = threshold - 1; k >= 1; k--) acc = gfMul(acc ^ coefficients[k - 1]![i]!, x);
      y[i] = acc ^ secret[i]!;
    }
    shares.push({ x, y });
  }
  return shares;
}

/**
 * Reconstruct the secret from shares via Lagrange interpolation at x = 0.
 * Needs at least `threshold` shares; extra shares are fine (any subset of
 * size >= threshold interpolates to the same secret when all shares are
 * valid). Shares must all have the same length and distinct non-zero x.
 *
 * @throws when fewer than `threshold` shares are given, or shares are
 *         malformed (empty, mismatched lengths, duplicate or zero x).
 */
export function reconstructSecret(shares: KeyShare[], threshold: number): Uint8Array {
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new Error(`threshold must be an integer >= 2, got ${threshold}`);
  }
  if (shares.length < threshold) {
    throw new Error(
      `need at least ${threshold} shares to reconstruct, got ${shares.length}`,
    );
  }
  const length = shares[0]!.y.length;
  if (length === 0) throw new Error("shares must not be empty");
  const seen = new Set<number>();
  for (const s of shares) {
    if (!Number.isInteger(s.x) || s.x < 1 || s.x > 255) {
      throw new Error(`share x must be an integer in 1..255, got ${s.x}`);
    }
    if (seen.has(s.x)) throw new Error(`duplicate share x=${s.x}`);
    seen.add(s.x);
    if (s.y.length !== length) {
      throw new Error(
        `all shares must have the same length (${length}), got ${s.y.length} for x=${s.x}`,
      );
    }
  }

  // Lagrange basis at x=0: lambda_i = prod_{j != i} x_j / (x_j - x_i).
  // In GF(2^8) subtraction is XOR, so (x_j - x_i) = x_j ^ x_i.
  const secret = new Uint8Array(length);
  for (let i = 0; i < shares.length; i++) {
    const xi = shares[i]!.x;
    let lambda = 1;
    for (let j = 0; j < shares.length; j++) {
      if (i === j) continue;
      const xj = shares[j]!.x;
      lambda = gfMul(lambda, gfDiv(xj, xj ^ xi));
    }
    if (lambda === 0) continue;
    for (let b = 0; b < length; b++) {
      secret[b] ^= gfMul(lambda, shares[i]!.y[b]!);
    }
  }
  return secret;
}

/**
 * Commitment to a secret key, recorded when shares are created so a later
 * reconstruction can be verified without ever revealing the key itself.
 * keccak256 is preimage-resistant: the commitment leaks nothing usable
 * about the secret.
 */
export function secretCommitment(secret: Uint8Array): `0x${string}` {
  return keccak256(toHex(secret));
}
