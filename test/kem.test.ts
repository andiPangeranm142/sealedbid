/**
 * kem.test.ts - unit tests for the client-side ML-KEM-1024 sealing module.
 * No chain involved: pure crypto round-trips, size checks, tamper
 * detection, and commitment determinism.
 *
 * Run: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toHex, type Address } from "viem";
import {
  KEM_CIPHERTEXT_SIZE,
  KEM_PUBLIC_KEY_SIZE,
  KEM_SECRET_KEY_SIZE,
  computeCommitment,
  generateKemKeypair,
  kemPublicKeyHash,
  randomSalt,
  sealBid,
  unsealBid,
} from "../src/lib/kem.js";

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;

describe("generateKemKeypair", () => {
  it("produces FIPS 203 ML-KEM-1024 sized keys", () => {
    const kp = generateKemKeypair();
    assert.equal(kp.publicKey.length, KEM_PUBLIC_KEY_SIZE);
    assert.equal(kp.secretKey.length, KEM_SECRET_KEY_SIZE);
  });

  it("is deterministic with a seed and distinct without one", () => {
    const seed = new Uint8Array(64).fill(7);
    const a = generateKemKeypair(seed);
    const b = generateKemKeypair(seed);
    assert.deepEqual(a.publicKey, b.publicKey);
    assert.deepEqual(a.secretKey, b.secretKey);
    const c = generateKemKeypair();
    assert.notDeepEqual(a.publicKey, c.publicKey);
  });
});

describe("kemPublicKeyHash", () => {
  it("is stable for a key and distinct across keys", () => {
    const a = generateKemKeypair(new Uint8Array(64).fill(1));
    const b = generateKemKeypair(new Uint8Array(64).fill(2));
    assert.equal(kemPublicKeyHash(a.publicKey), kemPublicKeyHash(a.publicKey));
    assert.notEqual(kemPublicKeyHash(a.publicKey), kemPublicKeyHash(b.publicKey));
    assert.match(kemPublicKeyHash(a.publicKey), /^0x[0-9a-f]{64}$/);
  });
});

describe("sealBid / unsealBid", () => {
  it("round-trips a bid payload", () => {
    const kp = generateKemKeypair();
    const payload = { amount: "123456789", salt: randomSalt() };
    const sealed = sealBid(kp.publicKey, payload);
    assert.equal(sealed.kemCiphertext.length, KEM_CIPHERTEXT_SIZE);
    assert.ok(sealed.sealedBid.length > 12 + 16);
    assert.deepEqual(unsealBid(kp.secretKey, sealed.kemCiphertext, sealed.sealedBid), payload);
  });

  it("produces different ciphertexts for the same payload (randomised encapsulation)", () => {
    const kp = generateKemKeypair();
    const payload = { amount: "1000", salt: randomSalt() };
    const s1 = sealBid(kp.publicKey, payload);
    const s2 = sealBid(kp.publicKey, payload);
    assert.notDeepEqual(s1.kemCiphertext, s2.kemCiphertext);
    assert.notDeepEqual(s1.sealedBid, s2.sealedBid);
    assert.deepEqual(unsealBid(kp.secretKey, s2.kemCiphertext, s2.sealedBid), payload);
  });

  it("fails to open with the wrong secret key", () => {
    const kp = generateKemKeypair();
    const other = generateKemKeypair();
    const sealed = sealBid(kp.publicKey, { amount: "1000", salt: randomSalt() });
    assert.throws(() =>
      unsealBid(other.secretKey, sealed.kemCiphertext, sealed.sealedBid),
    );
  });

  it("detects a tampered sealed blob (GCM tag)", () => {
    const kp = generateKemKeypair();
    const sealed = sealBid(kp.publicKey, { amount: "1000", salt: randomSalt() });
    const tampered = new Uint8Array(sealed.sealedBid);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => unsealBid(kp.secretKey, sealed.kemCiphertext, tampered));
  });

  it("detects a tampered KEM ciphertext (wrong shared secret => GCM failure)", () => {
    const kp = generateKemKeypair();
    const sealed = sealBid(kp.publicKey, { amount: "1000", salt: randomSalt() });
    const tampered = new Uint8Array(sealed.kemCiphertext);
    tampered[100] ^= 0x01;
    assert.throws(() => unsealBid(kp.secretKey, tampered, sealed.sealedBid));
  });

  it("rejects wrong-sized keys and ciphertexts", () => {
    const kp = generateKemKeypair();
    assert.throws(() => sealBid(kp.publicKey.slice(0, 100), { amount: "1", salt: randomSalt() }));
    const sealed = sealBid(kp.publicKey, { amount: "1", salt: randomSalt() });
    assert.throws(() => unsealBid(kp.secretKey.slice(0, 100), sealed.kemCiphertext, sealed.sealedBid));
    assert.throws(() => unsealBid(kp.secretKey, sealed.kemCiphertext.slice(0, 100), sealed.sealedBid));
    assert.throws(() => unsealBid(kp.secretKey, sealed.kemCiphertext, new Uint8Array(10)));
  });
});

describe("computeCommitment", () => {
  it("is deterministic and binds amount, salt and bidder", () => {
    const salt = randomSalt();
    const c = computeCommitment(1000n, salt, ALICE);
    assert.equal(c, computeCommitment(1000n, salt, ALICE));
    assert.notEqual(c, computeCommitment(1001n, salt, ALICE));
    assert.notEqual(c, computeCommitment(1000n, randomSalt(), ALICE));
    assert.notEqual(c, computeCommitment(1000n, salt, BOB));
    assert.match(c, /^0x[0-9a-f]{64}$/);
  });
});

describe("randomSalt", () => {
  it("returns 32 random bytes as 0x hex", () => {
    const s1 = randomSalt();
    const s2 = randomSalt();
    assert.match(s1, /^0x[0-9a-f]{64}$/);
    assert.notEqual(s1, s2);
  });
});

describe("sealed payload hides the amount", () => {
  it("neither the ciphertext nor the blob contains the amount in the clear", () => {
    const kp = generateKemKeypair();
    const sealed = sealBid(kp.publicKey, { amount: "987654321", salt: randomSalt() });
    const haystack = Buffer.concat([
      Buffer.from(sealed.kemCiphertext),
      Buffer.from(sealed.sealedBid),
    ]).toString("latin1");
    assert.ok(!haystack.includes("987654321"), "amount leaked into the sealed bid");
    assert.ok(!haystack.includes(toHex(new Uint8Array([9, 8, 7]))), "amount bytes leaked");
  });
});
