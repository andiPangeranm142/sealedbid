/**
 * finalize.ts - finalise old SealedBid auctions whose reveal deadline has
 * passed. finalize() is callable by anyone; this script calls it from the
 * deployer account and verifies every finalisation afterwards by reading
 * the auction state back from the chain.
 *
 * Usage (run from the repo dir, with a live deployer EVM window):
 *   npx tsx --env-file=.env scripts/finalize.ts [id ...]
 * With no ids it finalises the known-unfinalised old auctions: 1 2 3 4 5 8 10 12.
 *
 * NEVER finalises auction 13 (the Q-Day Drill lot) — a reveal cron runs
 * 20 Nov 07:30 WIB and a finalize cron 21 Nov 07:30 WIB. The guard is
 * hard-coded: passing 13 aborts the run.
 *
 * Writes deployments/finalize.json with every tx hash, block, Cosmos hash
 * and verified winner. Testnet only.
 */
import { qorechainTestnet } from "@qorechain/evm";
import type { Chain } from "viem";
const testnet = qorechainTestnet as unknown as Chain;
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { sealedBidAbi } from "../contracts/SealedBid.artifact.js";
import { CHAIN_ID, EVM_RPC, cosmosHashForEvmTx } from "./qore.js";

/** The Q-Day Drill lot. NEVER touch it from this script. */
const DRILL_AUCTION_ID = 13n;
/** Default set: old auctions whose reveal deadline has passed. */
const DEFAULT_IDS = [1n, 2n, 3n, 4n, 5n, 8n, 10n, 12n];

/** Explicit fee caps: the chain's fee market is volatile (see README). */
const MAX_FEE_PER_GAS = 150_000_000_000n; // 150 gwei
const MAX_PRIORITY_FEE = 12_500_000_000n; // 12.5 gwei
const FINALIZE_GAS = 200_000n;

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "..");

type AuctionTuple = [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

async function main(): Promise<void> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in .env");
  const ids = process.argv.slice(2).length
    ? process.argv.slice(2).map((s) => BigInt(s))
    : DEFAULT_IDS;
  if (ids.includes(DRILL_AUCTION_ID)) {
    throw new Error(
      `Refusing to finalise auction ${DRILL_AUCTION_ID} (Q-Day Drill lot — owned by the reveal/finalize crons).`,
    );
  }
  const deployment = JSON.parse(
    fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address };
  const contract = deployment.contract;
  console.log(`contract: ${contract} (${CHAIN_ID})`);

  const publicClient = createPublicClient({ chain: testnet, transport: http(EVM_RPC) });
  const wallet = createWalletClient({
    account: mnemonicToAccount(mnemonic),
    chain: testnet,
    transport: http(EVM_RPC),
  });
  const count = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "auctionCount",
  })) as bigint;
  console.log(`auctionCount: ${count}`);
  for (const id of ids) {
    if (id >= count) throw new Error(`auction ${id} does not exist (auctionCount ${count})`);
  }

  const results: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const before = (await publicClient.readContract({
      address: contract, abi: sealedBidAbi, functionName: "auctions", args: [id],
    })) as unknown as AuctionTuple;
    const now = Math.floor(Date.now() / 1000);
    console.log(
      `\n#${id} "${before[1]}": finalized=${before[8]}, revealDeadline=${before[4]} (now ${now}), ` +
        `highest=${before[6]} by ${before[7]}`,
    );
    if (before[8]) {
      console.log("  already finalised — skipping (no tx sent).");
      results.push({
        auctionId: id.toString(),
        action: "skipped-already-finalized",
        winner: before[7] === ZERO_ADDRESS ? null : before[7],
        winningBidUqor: before[6].toString(),
      });
      continue;
    }
    if (now < Number(before[4])) {
      throw new Error(`auction ${id}: reveal deadline has not passed yet — refusing to finalise`);
    }
    const hash = await wallet.writeContract({
      address: contract,
      abi: sealedBidAbi,
      functionName: "finalize",
      args: [id],
      chain: testnet,
      gas: FINALIZE_GAS,
      maxFeePerGas: MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`auction ${id}: finalize tx ${hash} reverted`);
    const { cosmosHash, block } = await cosmosHashForEvmTx(publicClient, hash);
    // Verify afterwards: re-read the auction and require finalized=true with
    // the same winner/highest bid as before (finalize must not change them).
    const after = (await publicClient.readContract({
      address: contract, abi: sealedBidAbi, functionName: "auctions", args: [id],
    })) as unknown as AuctionTuple;
    const phase = (await publicClient.readContract({
      address: contract, abi: sealedBidAbi, functionName: "phaseOf", args: [id],
    })) as number;
    if (!after[8] || phase !== 2) {
      throw new Error(`auction ${id}: state after finalize is not Finalized (finalized=${after[8]}, phase=${phase})`);
    }
    if (after[6] !== before[6] || after[7].toLowerCase() !== before[7].toLowerCase()) {
      throw new Error(`auction ${id}: winner changed during finalise (before ${before[7]}/${before[6]}, after ${after[7]}/${after[6]})`);
    }
    console.log(
      `  FINALIZED: tx ${hash} block ${receipt.blockNumber} (Cosmos ${cosmosHash}) — ` +
        `winner ${after[7] === ZERO_ADDRESS ? "none" : after[7]} at ${after[6]} uqor`,
    );
    results.push({
      auctionId: id.toString(),
      action: "finalized",
      finalizeTx: hash,
      finalizeBlock: receipt.blockNumber.toString(),
      finalizeTxCosmos: cosmosHash,
      winner: after[7] === ZERO_ADDRESS ? null : after[7],
      winningBidUqor: after[6].toString(),
    });
  }

  const out = {
    contract,
    finalizedBy: wallet.account.address,
    finalizedAt: new Date().toISOString(),
    results,
  };
  const outPath = path.join(ROOT, "deployments", "finalize.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${outPath}`);
}

main().catch((err: unknown) => {
  console.error("\nFinalize run failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
