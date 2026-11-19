/**
 * sealedbid.test.ts - end-to-end tests for the SealedBid contract on a
 * local in-memory Ganache chain (plain EVM, no PQC window: the window is a
 * QoreChain admission rule, not contract logic). The bids use the REAL
 * client-side crypto module (ML-KEM-1024 + AES-GCM), so the test exercises
 * the same seal -> submit -> reveal path the UI and scripts use.
 *
 * The accounts are Ganache's built-in deterministic test accounts. They are
 * public test keys that exist only on this throwaway local chain; they are
 * NEVER funded anywhere and must never be used on testnet or mainnet.
 *
 * Run: npm test
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Ganache from "ganache";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { sealedBidAbi, sealedBidBytecode } from "../contracts/SealedBid.artifact.js";
import {
  computeCommitment,
  generateKemKeypair,
  kemPublicKeyHash,
  randomSalt,
  sealBid,
  unsealBid,
} from "../src/lib/kem.js";

/**
 * The well-known public test mnemonic (Hardhat's default). It funds NOTHING
 * outside this throwaway local chain: Ganache mints its local accounts from
 * it, and viem derives the same local signers from it, so transactions go
 * through viem's local-account path (with gas estimation) exactly like the
 * real deploy script does. Never use this mnemonic anywhere else.
 */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

const localChain = defineChain({
  id: 1337,
  name: "Ganache Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

type Clients = ReturnType<typeof createClients>;

function createClients(provider: ReturnType<typeof Ganache.provider>) {
  const transport = custom(provider as never);
  return {
    public: createPublicClient({ chain: localChain, transport }),
    wallet: createWalletClient({ chain: localChain, transport }),
  };
}

/** Advance the local chain's clock (Ganache evm_increaseTime + mine). */
async function advanceTime(clients: Clients, seconds: number): Promise<void> {
  await clients.public.transport.request({ method: "evm_increaseTime", params: [seconds] });
  await clients.public.transport.request({ method: "evm_mine", params: [] });
}

describe("SealedBid artifact", () => {
  it("exposes the expected ABI entries and non-empty bytecode", () => {
    const names = new Set(
      sealedBidAbi
        .filter((e): e is { type: string; name: string } => "name" in e)
        .map((e) => e.name),
    );
    for (const name of [
      "createAuction",
      "submitBid",
      "revealBid",
      "finalize",
      "phaseOf",
      "getBidders",
      "bidCount",
      "auctionCount",
      "auctions",
      "bids",
      "hasBid",
      "AuctionCreated",
      "BidSubmitted",
      "BidRevealed",
      "AuctionFinalized",
    ]) {
      assert.ok(names.has(name), `ABI is missing ${name}`);
    }
    assert.ok(sealedBidBytecode.startsWith("0x"));
    assert.ok(sealedBidBytecode.length > 100, "bytecode looks too short");
  });
});

describe("SealedBid contract", () => {
  let clients: Clients;
  let provider: ReturnType<typeof Ganache.provider>;
  let contract: Address;
  let auctioneer: ReturnType<typeof mnemonicToAccount>;
  let bidder1: ReturnType<typeof mnemonicToAccount>;
  let bidder2: ReturnType<typeof mnemonicToAccount>;
  let bidder3: ReturnType<typeof mnemonicToAccount>;

  before(async () => {
    provider = Ganache.provider({ wallet: { mnemonic: TEST_MNEMONIC }, logging: { quiet: true } });
    clients = createClients(provider);
    auctioneer = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 });
    bidder1 = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });
    bidder2 = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 2 });
    bidder3 = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 3 });

    const hash = await clients.wallet.deployContract({
      abi: sealedBidAbi,
      bytecode: sealedBidBytecode as Hex,
      account: auctioneer,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.ok(receipt.contractAddress, "deployment receipt has no contract address");
    contract = receipt.contractAddress;
    assert.equal(receipt.status, "success");
  });

  after(async () => {
    await provider.disconnect();
  });

  async function createAuction(opts: {
    item?: string;
    bidding?: number;
    reveal?: number;
    minBid?: bigint;
  } = {}): Promise<{ auctionId: bigint; keypair: ReturnType<typeof generateKemKeypair> }> {
    const keypair = generateKemKeypair();
    const hash = await clients.wallet.writeContract({
      address: contract,
      abi: sealedBidAbi,
      functionName: "createAuction",
      args: [
        opts.item ?? "Test item",
        toHex(keypair.publicKey),
        BigInt(opts.bidding ?? 3600),
        BigInt(opts.reveal ?? 3600),
        opts.minBid ?? 0n,
      ],
      account: auctioneer,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    const created = receipt.logs
      .map((log) => {
        try {
          return decodeEventLog({ abi: sealedBidAbi, data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      })
      .find((e) => e?.eventName === "AuctionCreated");
    assert.ok(created, "AuctionCreated event not found");
    const args = created.args as unknown as { auctionId: bigint; kemKeyHash: Hex };
    // The stored hash must bind the auction to the key that was passed in.
    assert.equal(args.kemKeyHash, kemPublicKeyHash(keypair.publicKey));
    return { auctionId: args.auctionId, keypair };
  }

  async function submitSealedBid(
    auctionId: bigint,
    bidder: ReturnType<typeof mnemonicToAccount>,
    keypair: ReturnType<typeof generateKemKeypair>,
    amount: bigint,
  ): Promise<{ salt: Hex; commitment: Hex }> {
    const salt = randomSalt();
    const sealed = sealBid(keypair.publicKey, { amount: amount.toString(), salt });
    const commitment = computeCommitment(amount, salt, bidder.address);
    const hash = await clients.wallet.writeContract({
      address: contract,
      abi: sealedBidAbi,
      functionName: "submitBid",
      args: [auctionId, toHex(sealed.kemCiphertext), toHex(sealed.sealedBid), commitment],
      account: bidder,
      chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return { salt, commitment };
  }

  it("starts empty", async () => {
    assert.equal(
      await clients.public.readContract({ address: contract, abi: sealedBidAbi, functionName: "auctionCount" }),
      0n,
    );
  });

  it("creates an auction in the Bidding phase", async () => {
    const { auctionId } = await createAuction({ item: "First lot" });
    assert.equal(auctionId, 0n);
    assert.equal(
      await clients.public.readContract({ address: contract, abi: sealedBidAbi, functionName: "auctionCount" }),
      1n,
    );
    const phase = await clients.public.readContract({
      address: contract,
      abi: sealedBidAbi,
      functionName: "phaseOf",
      args: [auctionId],
    });
    assert.equal(phase, 0); // Bidding
  });

  it("rejects an auction with a wrong-sized KEM public key", async () => {
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract,
        abi: sealedBidAbi,
        functionName: "createAuction",
        args: ["Bad key", "0x1234", 3600n, 3600n, 0n],
        account: auctioneer,
        chain: localChain,
      }),
    );
  });

  it("runs a full auction: sealed bids, reveals, winner", async () => {
    const { auctionId, keypair } = await createAuction({ bidding: 60, reveal: 60 });
    const bid1 = await submitSealedBid(auctionId, bidder1, keypair, 1000n);
    const bid2 = await submitSealedBid(auctionId, bidder2, keypair, 2500n);
    const bid3 = await submitSealedBid(auctionId, bidder3, keypair, 1500n);

    assert.equal(
      await clients.public.readContract({
        address: contract, abi: sealedBidAbi, functionName: "bidCount", args: [auctionId],
      }),
      3n,
    );

    // The auctioneer can decrypt every sealed bid off-chain (and the
    // decrypted amounts match what the bidders will reveal).
    for (const [bidder, amount] of [
      [bidder1, "1000"],
      [bidder2, "2500"],
      [bidder3, "1500"],
    ] as const) {
      // viem returns struct getters as positional tuples.
      const stored = (await clients.public.readContract({
        address: contract, abi: sealedBidAbi, functionName: "bids", args: [auctionId, bidder.address],
      })) as unknown as [Hex, Hex, Hex, bigint, boolean];
      const opened = unsealBid(
        keypair.secretKey,
        Buffer.from(stored[0].slice(2), "hex"),
        Buffer.from(stored[1].slice(2), "hex"),
      );
      assert.equal(opened.amount, amount);
    }

    // Reveals are rejected while bidding is still open.
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "revealBid",
        args: [auctionId, 1000n, bid1.salt], account: bidder1, chain: localChain,
      }),
    );

    await advanceTime(clients, 61);
    assert.equal(
      await clients.public.readContract({
        address: contract, abi: sealedBidAbi, functionName: "phaseOf", args: [auctionId],
      }),
      1, // Revealing
    );

    // A wrong amount does not match the commitment.
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "revealBid",
        args: [auctionId, 9999n, bid1.salt], account: bidder1, chain: localChain,
      }),
    );
    // A wrong salt does not match either.
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "revealBid",
        args: [auctionId, 1000n, randomSalt()], account: bidder1, chain: localChain,
      }),
    );

    // Reveal all three (out of order: lowest first).
    for (const [bidder, amount, salt] of [
      [bidder1, 1000n, bid1.salt],
      [bidder3, 1500n, bid3.salt],
      [bidder2, 2500n, bid2.salt],
    ] as const) {
      const hash = await clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "revealBid",
        args: [auctionId, amount, salt], account: bidder, chain: localChain,
      });
      const receipt = await clients.public.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
    }

    // A second reveal from the same bidder is rejected.
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "revealBid",
        args: [auctionId, 1000n, bid1.salt], account: bidder1, chain: localChain,
      }),
    );

    // Highest revealed bid wins, regardless of reveal order.
    const auction = (await clients.public.readContract({
      address: contract, abi: sealedBidAbi, functionName: "auctions", args: [auctionId],
    })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean, Address[]];
    assert.equal(auction[6], 2500n); // highestBid
    assert.equal(auction[7].toLowerCase(), bidder2.address.toLowerCase()); // highestBidder

    // Finalise is rejected before the reveal deadline.
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "finalize",
        args: [auctionId], account: auctioneer, chain: localChain,
      }),
    );

    await advanceTime(clients, 61);
    const finHash = await clients.wallet.writeContract({
      address: contract, abi: sealedBidAbi, functionName: "finalize",
      args: [auctionId], account: bidder3, chain: localChain, // anyone may finalise
    });
    const finReceipt = await clients.public.waitForTransactionReceipt({ hash: finHash });
    assert.equal(finReceipt.status, "success");
    const finEvent = finReceipt.logs
      .map((log) => {
        try {
          return decodeEventLog({ abi: sealedBidAbi, data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      })
      .find((e) => e?.eventName === "AuctionFinalized");
    assert.ok(finEvent, "AuctionFinalized event not found");
    const fArgs = finEvent.args as unknown as { winner: Address; winningBid: bigint };
    assert.equal(fArgs.winner.toLowerCase(), bidder2.address.toLowerCase());
    assert.equal(fArgs.winningBid, 2500n);
    assert.equal(
      await clients.public.readContract({
        address: contract, abi: sealedBidAbi, functionName: "phaseOf", args: [auctionId],
      }),
      2, // Finalized
    );
  });

  it("enforces one bid per bidder and the bidding deadline", async () => {
    const { auctionId, keypair } = await createAuction({ bidding: 30, reveal: 30 });
    await submitSealedBid(auctionId, bidder1, keypair, 100n);
    // Second bid from the same bidder.
    await assert.rejects(submitSealedBid(auctionId, bidder1, keypair, 200n));
    // A bid after the deadline.
    await advanceTime(clients, 31);
    await assert.rejects(submitSealedBid(auctionId, bidder2, keypair, 200n));
  });

  it("rejects a wrong-sized KEM ciphertext", async () => {
    const { auctionId } = await createAuction({ bidding: 3600, reveal: 3600 });
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "submitBid",
        args: [auctionId, "0x1234", "0xabcd", ("0x" + "00".repeat(32)) as Hex],
        account: bidder1, chain: localChain,
      }),
    );
  });

  it("enforces the minimum bid at reveal time", async () => {
    const { auctionId, keypair } = await createAuction({ bidding: 30, reveal: 30, minBid: 500n });
    const low = await submitSealedBid(auctionId, bidder1, keypair, 100n);
    await advanceTime(clients, 31);
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "revealBid",
        args: [auctionId, 100n, low.salt], account: bidder1, chain: localChain,
      }),
    );
  });

  it("finalises with no winner when nothing was revealed", async () => {
    const { auctionId, keypair } = await createAuction({ bidding: 30, reveal: 30 });
    await submitSealedBid(auctionId, bidder1, keypair, 100n);
    await advanceTime(clients, 61);
    const hash = await clients.wallet.writeContract({
      address: contract, abi: sealedBidAbi, functionName: "finalize",
      args: [auctionId], account: auctioneer, chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    const auction = (await clients.public.readContract({
      address: contract, abi: sealedBidAbi, functionName: "auctions", args: [auctionId],
    })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean, Address[]];
    assert.equal(auction[6], 0n); // highestBid
    assert.equal(auction[7], "0x0000000000000000000000000000000000000000"); // highestBidder
  });

  it("rejects a second finalise of the same auction", async () => {
    const { auctionId } = await createAuction({ bidding: 30, reveal: 30 });
    await advanceTime(clients, 61);
    const hash = await clients.wallet.writeContract({
      address: contract, abi: sealedBidAbi, functionName: "finalize",
      args: [auctionId], account: auctioneer, chain: localChain,
    });
    assert.equal((await clients.public.waitForTransactionReceipt({ hash })).status, "success");
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "finalize",
        args: [auctionId], account: bidder1, chain: localChain,
      }),
    );
  });

  it("rejects finalise, bid and reveal on an auction that does not exist", async () => {
    const count = (await clients.public.readContract({
      address: contract, abi: sealedBidAbi, functionName: "auctionCount",
    })) as bigint;
    const missing = count + 100n;
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "finalize",
        args: [missing], account: auctioneer, chain: localChain,
      }),
    );
    const keypair = generateKemKeypair();
    const salt = randomSalt();
    const sealed = sealBid(keypair.publicKey, { amount: "100", salt });
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "submitBid",
        args: [missing, toHex(sealed.kemCiphertext), toHex(sealed.sealedBid),
          computeCommitment(100n, salt, bidder1.address)],
        account: bidder1, chain: localChain,
      }),
    );
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "revealBid",
        args: [missing, 100n, salt], account: bidder1, chain: localChain,
      }),
    );
  });

  it("rejects a reveal after the reveal deadline", async () => {
    const { auctionId, keypair } = await createAuction({ bidding: 30, reveal: 30 });
    const bid = await submitSealedBid(auctionId, bidder1, keypair, 100n);
    await advanceTime(clients, 61); // past both deadlines
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "revealBid",
        args: [auctionId, 100n, bid.salt], account: bidder1, chain: localChain,
      }),
    );
    // The unrevealed bid does not count: finalise still yields no winner.
    const hash = await clients.wallet.writeContract({
      address: contract, abi: sealedBidAbi, functionName: "finalize",
      args: [auctionId], account: auctioneer, chain: localChain,
    });
    assert.equal((await clients.public.waitForTransactionReceipt({ hash })).status, "success");
    const auction = (await clients.public.readContract({
      address: contract, abi: sealedBidAbi, functionName: "auctions", args: [auctionId],
    })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean, Address[]];
    assert.equal(auction[7], "0x0000000000000000000000000000000000000000");
  });

  it("rejects a reveal from an address that never bid", async () => {
    const { auctionId, keypair } = await createAuction({ bidding: 30, reveal: 30 });
    await submitSealedBid(auctionId, bidder1, keypair, 100n);
    await advanceTime(clients, 31);
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "revealBid",
        args: [auctionId, 100n, randomSalt()], account: bidder2, chain: localChain,
      }),
    );
  });

  it("rejects auctions with zero bidding or reveal durations", async () => {
    const keypair = generateKemKeypair();
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "createAuction",
        args: ["No bidding", toHex(keypair.publicKey), 0n, 3600n, 0n],
        account: auctioneer, chain: localChain,
      }),
    );
    await assert.rejects(
      clients.wallet.writeContract({
        address: contract, abi: sealedBidAbi, functionName: "createAuction",
        args: ["No reveal", toHex(keypair.publicKey), 3600n, 0n, 0n],
        account: auctioneer, chain: localChain,
      }),
    );
  });

  it("finalise is callable by anyone, not just the auctioneer", async () => {
    // A bystander (bidder3, who never bid on this auction) finalises it.
    const { auctionId, keypair } = await createAuction({ bidding: 30, reveal: 30 });
    const bid = await submitSealedBid(auctionId, bidder1, keypair, 100n);
    await advanceTime(clients, 31);
    const revealHash = await clients.wallet.writeContract({
      address: contract, abi: sealedBidAbi, functionName: "revealBid",
      args: [auctionId, 100n, bid.salt], account: bidder1, chain: localChain,
    });
    assert.equal((await clients.public.waitForTransactionReceipt({ hash: revealHash })).status, "success");
    await advanceTime(clients, 31);
    const finHash = await clients.wallet.writeContract({
      address: contract, abi: sealedBidAbi, functionName: "finalize",
      args: [auctionId], account: bidder3, chain: localChain,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash: finHash });
    assert.equal(receipt.status, "success");
    const auction = (await clients.public.readContract({
      address: contract, abi: sealedBidAbi, functionName: "auctions", args: [auctionId],
    })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean, Address[]];
    assert.equal(auction[8], true); // finalized
    assert.equal(auction[7].toLowerCase(), bidder1.address.toLowerCase());
  });
});
