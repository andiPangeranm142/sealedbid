/**
 * threshold.test.ts - tests for the Shamir 2-of-3 threshold opening ceremony
 * (src/lib/threshold.ts). No chain involved: pure cryptography, plus a full
 * round-trip through the real ML-KEM-1024 sealing module.
 *
 * The security property under test is information-theoretic: ONE share
 * reveals nothing about the secret. That is tested directly (see
 * "one share is consistent with any secret"), not just by checking that the
 * API refuses to reconstruct from a single share.
 *
 * Run: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KEM_SECRET_KEY_SIZE,
  generateKemKeypair,
  randomSalt,
  sealBid,
  unsealBid,
} from "../src/lib/kem.js";
import {
  gfDiv,
  gfInv,
  gfMul,
  reconstructSecret,
  secretCommitment,
  splitSecret,
  type KeyShare,
} from "../src/lib/threshold.js";

function randomSecret(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

describe("GF(2^8) arithmetic", () => {
  it("multiplication, division and inverse satisfy the field axioms", () => {
    for (const [a, b] of [
      [2, 3],
      [0x53, 0xca],
      [0x57, 0x13],
      [255, 255],
      [1, 200],
    ] as const) {
      assert.equal(gfDiv(gfMul(a, b), b), a);
      assert.equal(gfMul(a, gfInv(a)), 1);
      assert.equal(gfMul(a, b), gfMul(b, a));
    }
    assert.equal(gfMul(0, 123), 0);
    assert.equal(gfMul(1, 123), 123);
    assert.throws(() => gfDiv(1, 0));
    assert.throws(() => gfInv(0));
  });

  it("the generator has full order 255 (log/exp tables cover the field)", () => {
    // Every non-zero element is reachable: x^255 == 1 for all x != 0, and
    // the map a -> a * g is a permutation (no two log entries collide).
    const seen = new Set<number>();
    let x = 1;
    for (let i = 0; i < 255; i++) {
      assert.ok(!seen.has(x), `generator cycle repeated at step ${i}`);
      seen.add(x);
      x = gfMul(x, 3);
    }
    assert.equal(x, 1, "generator must return to 1 after exactly 255 steps");
    assert.equal(seen.size, 255);
  });
});

describe("splitSecret / reconstructSecret", () => {
  it("round-trips secrets of several lengths", () => {
    for (const length of [1, 16, 32, 256, KEM_SECRET_KEY_SIZE]) {
      const secret = randomSecret(length);
      const shares = splitSecret(secret, 2, 3);
      assert.equal(shares.length, 3);
      assert.deepEqual(shares.map((s) => s.x), [1, 2, 3]);
      for (const s of shares) assert.equal(s.y.length, length);
      assert.deepEqual(reconstructSecret(shares.slice(0, 2), 2), secret);
    }
  });

  it("reconstructs from every pair of the 3 shares", () => {
    const secret = randomSecret(64);
    const shares = splitSecret(secret, 2, 3);
    for (const pair of [
      [shares[0]!, shares[1]!],
      [shares[0]!, shares[2]!],
      [shares[1]!, shares[2]!],
    ]) {
      assert.deepEqual(reconstructSecret(pair, 2), secret);
    }
  });

  it("reconstructs from all 3 shares (extra shares are fine)", () => {
    const secret = randomSecret(64);
    const shares = splitSecret(secret, 2, 3);
    assert.deepEqual(reconstructSecret(shares, 2), secret);
  });

  it("produces different shares on each split, both reconstructing", () => {
    const secret = randomSecret(64);
    const a = splitSecret(secret, 2, 3);
    const b = splitSecret(secret, 2, 3);
    assert.notDeepEqual(a[0]!.y, b[0]!.y);
    assert.deepEqual(reconstructSecret([a[0]!, a[2]!], 2), secret);
    assert.deepEqual(reconstructSecret([b[1]!, b[2]!], 2), secret);
  });

  it("refuses to reconstruct from a single share", () => {
    const secret = randomSecret(32);
    const [share] = splitSecret(secret, 2, 3);
    assert.throws(() => reconstructSecret([share!], 2), /at least 2 shares/);
    assert.throws(() => reconstructSecret([], 2), /at least 2 shares/);
  });

  it("one share is consistent with ANY secret (information-theoretic)", () => {
    // Fix share 1 (x=1) from a real split of the true secret. For each of
    // two DIFFERENT target secrets T, build the share at x=2 that lies on
    // the line through (0, T) and (1, y1): the line is y = T + c*x with
    // c = y1 ^ T, so y2 = T ^ 2*c. Both forged pairs reconstruct — to
    // different secrets — proving share 1 alone determines nothing.
    const secret = randomSecret(32);
    const [share1] = splitSecret(secret, 2, 3);
    const targets = [randomSecret(32), randomSecret(32)];
    for (const target of targets) {
      const forged: KeyShare = { x: 2, y: new Uint8Array(32) };
      for (let i = 0; i < 32; i++) {
        const c = share1!.y[i]! ^ target[i]!;
        forged.y[i] = target[i]! ^ gfMul(2, c);
      }
      assert.deepEqual(reconstructSecret([share1!, forged], 2), target);
    }
    assert.notDeepEqual(targets[0], targets[1]);
    assert.notDeepEqual(targets[0], secret);
  });

  it("a tampered share reconstructs to a key the commitment rejects", () => {
    const secret = randomSecret(64);
    const shares = splitSecret(secret, 2, 3);
    const commitment = secretCommitment(secret);
    const tampered: KeyShare = { x: 2, y: new Uint8Array(shares[1]!.y) };
    tampered.y[10]! ^= 0x01;
    const bad = reconstructSecret([shares[0]!, tampered], 2);
    assert.notDeepEqual(bad, secret);
    assert.notEqual(secretCommitment(bad), commitment);
    // And the untampered pair still verifies.
    assert.equal(secretCommitment(reconstructSecret([shares[0]!, shares[2]!], 2)), commitment);
  });

  it("rejects malformed shares", () => {
    const secret = randomSecret(32);
    const shares = splitSecret(secret, 2, 3);
    // Duplicate x.
    assert.throws(
      () => reconstructSecret([shares[0]!, { x: 1, y: new Uint8Array(32) }], 2),
      /duplicate share/,
    );
    // x = 0 is the secret's own coordinate and is never a valid share.
    assert.throws(
      () => reconstructSecret([shares[0]!, { x: 0, y: new Uint8Array(32) }], 2),
      /1\.\.255/,
    );
    // Mismatched lengths.
    assert.throws(
      () => reconstructSecret([shares[0]!, { x: 2, y: new Uint8Array(16) }], 2),
      /same length/,
    );
  });

  it("rejects invalid split parameters", () => {
    const secret = randomSecret(32);
    assert.throws(() => splitSecret(secret, 1, 3), /threshold/);
    assert.throws(() => splitSecret(secret, 4, 3), /totalShares/);
    assert.throws(() => splitSecret(secret, 2, 256), /255/);
    assert.throws(() => splitSecret(new Uint8Array(0), 2, 3), /empty/);
  });
});

describe("secretCommitment", () => {
  it("is stable for a secret and distinct across secrets", () => {
    const a = randomSecret(64);
    const b = randomSecret(64);
    assert.equal(secretCommitment(a), secretCommitment(a));
    assert.notEqual(secretCommitment(a), secretCommitment(b));
    assert.match(secretCommitment(a), /^0x[0-9a-f]{64}$/);
  });
});

describe("threshold opening of a real ML-KEM-1024 key", () => {
  it("2-of-3 shares open a sealed bid; 1 share cannot", () => {
    const kp = generateKemKeypair();
    const commitment = secretCommitment(kp.secretKey);
    const shares = splitSecret(kp.secretKey, 2, 3);

    const payload = { amount: "2500000", salt: randomSalt() };
    const sealed = sealBid(kp.publicKey, payload);

    // Any 2 shares reconstruct the key and open the bid.
    for (const pair of [
      [shares[0]!, shares[1]!],
      [shares[1]!, shares[2]!],
    ]) {
      const recovered = reconstructSecret(pair, 2);
      assert.equal(secretCommitment(recovered), commitment);
      assert.deepEqual(unsealBid(recovered, sealed.kemCiphertext, sealed.sealedBid), payload);
    }

    // One share is refused by the API — and even a forged second share
    // only opens the bid for a DIFFERENT secret, never this one.
    assert.throws(() => reconstructSecret([shares[0]!], 2));
  });

  it("a key reconstructed from a tampered share fails to open bids (GCM auth)", () => {
    const kp = generateKemKeypair();
    const shares = splitSecret(kp.secretKey, 2, 3);
    const sealed = sealBid(kp.publicKey, { amount: "1000", salt: randomSalt() });
    const tampered: KeyShare = { x: 3, y: new Uint8Array(shares[2]!.y) };
    tampered.y[0]! ^= 0xff;
    const badKey = reconstructSecret([shares[0]!, tampered], 2);
    assert.notEqual(secretCommitment(badKey), secretCommitment(kp.secretKey));
    assert.throws(() => unsealBid(badKey, sealed.kemCiphertext, sealed.sealedBid));
  });
});
