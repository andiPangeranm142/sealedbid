/**
 * finalize-drill.ts - finalise ONLY the SealedBid Q-Day Drill lot (auction 13).
 *
 * The generic scripts/finalize.ts hard-refuses auction 13 (it is owned by the
 * reveal/finalize crons); this script is the dedicated counterpart for the drill
 * lot, run once after the reveal deadline (2026-11-21 00:00 UTC) has passed.
 *
 * Preconditions checked on-chain before sending anything:
 *   - reveal deadline has passed
 *   - drill bidder 0x5EF93C32F1C7A1C80b6331CFEd7a1Fe0e5DfdC00 has revealed=true,
 *     amount 500000 uqor, commitment matching deployments/drill-bid.json
 *   - auction not already finalised
 * finalize() is callable by anyone; this calls it from the deployer account
 * (needs a live EVM window: `npm run window open` first).
 *
 * Usage (run from the repo dir, with a live deployer EVM window):
 *   npx tsx --env-file=.env scripts/finalize-drill.ts
 *
 * Writes deployments/drill-finalize.json with tx hash, block, Cosmos hash and
 * verified winner. Testnet only.
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

/** The Q-Day Drill lot. This script finalises ONLY this auction. */
const DRILL_AUCTION_ID = 13n;
const DRILL_BIDDER = "0x5EF93C32F1C7A1C80b6331CFEd7a1Fe0e5DfdC00".toLowerCase();
const DRILL_COMMITMENT =
  "0xf397e69bce9b8cfecabec289a914f2ea359a70ac71dc683a45c5d422bc37ed5d";
const DRILL_AMOUNT = 500000n;

/** Explicit fee caps: the chain's fee market is volatile (see README). */
const MAX_FEE_PER_GAS = 150_000_000_000n; // 150 gwei
const MAX_PRIORITY_FEE = 12_500_000_000n; // 12.5 gwei
const FINALIZE_GAS = 200_000n;

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "..");

type AuctionTuple = [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean];
type BidTuple = [Hex, Hex, Hex, bigint, boolean];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

async function main(): Promise<void> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in .env");
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

  const before = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "auctions", args: [DRILL_AUCTION_ID],
  })) as unknown as AuctionTuple;
  const now = Math.floor(Date.now() / 1000);
  console.log(
    `#${DRILL_AUCTION_ID} "${before[1]}": finalized=${before[8]}, revealDeadline=${before[4]} (now ${now}), ` +
      `highest=${before[6]} by ${before[7]}`,
  );
  if (before[8]) {
    console.log("already finalised — nothing to do (no tx sent).");
    return;
  }
  if (now < Number(before[4])) {
    throw new Error("reveal deadline has not passed yet — refusing to finalise");
  }
  // Guard: the drill bid MUST have been revealed before finalising, otherwise
  // finalising would lock in a different (empty) result.
  const bid = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "bids",
    args: [DRILL_AUCTION_ID, DRILL_BIDDER as Address],
  })) as unknown as BidTuple;
  console.log(`drill bidder: revealed=${bid[4]} amount=${bid[3]} commitment=${bid[2]}`);
  if (!bid[4]) throw new Error("drill bidder has NOT revealed — refusing to finalise blind");
  if (bid[3] !== DRILL_AMOUNT) {
    throw new Error(`revealed amount ${bid[3]} != expected ${DRILL_AMOUNT} — refusing to finalise`);
  }
  if (bid[2].toLowerCase() !== DRILL_COMMITMENT) {
    throw new Error("revealed commitment does not match drill-bid.json — refusing to finalise");
  }
  if (before[6] !== DRILL_AMOUNT || before[7].toLowerCase() !== DRILL_BIDDER) {
    throw new Error(
      `highest bid ${before[6]} by ${before[7]} != drill bid ${DRILL_AMOUNT} by ${DRILL_BIDDER} — refusing to finalise`,
    );
  }

  const hash = await wallet.writeContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "finalize",
    args: [DRILL_AUCTION_ID],
    chain: testnet,
    gas: FINALIZE_GAS,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`finalize tx ${hash} reverted`);
  const { cosmosHash, block } = await cosmosHashForEvmTx(publicClient, hash);

  const after = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "auctions", args: [DRILL_AUCTION_ID],
  })) as unknown as AuctionTuple;
  const phase = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "phaseOf", args: [DRILL_AUCTION_ID],
  })) as number;
  if (!after[8] || phase !== 2) {
    throw new Error(`state after finalize is not Finalized (finalized=${after[8]}, phase=${phase})`);
  }
  if (after[6] !== DRILL_AMOUNT || after[7].toLowerCase() !== DRILL_BIDDER) {
    throw new Error(`winner changed during finalise (after ${after[7]}/${after[6]})`);
  }
  console.log(
    `FINALIZED: tx ${hash} block ${receipt.blockNumber} (Cosmos ${cosmosHash}) — ` +
      `winner ${after[7]} at ${after[6]} uqor`,
  );

  const out = {
    action: "drill-finalize",
    auctionId: 13,
    contract,
    finalizedBy: wallet.account.address,
    finalizedAt: new Date().toISOString(),
    finalizeTx: hash,
    finalizeBlock: receipt.blockNumber.toString(),
    finalizeTxCosmos: cosmosHash,
    cosmosBlock: block?.toString() ?? null,
    winner: after[7],
    winningBidUqor: after[6].toString(),
    revealTx: "0x427541b5fcacbc7ef97981250ef64952c4a8c14cf5d7549f625f83b8b231b756",
    revealTxCosmos: "20972024211AD251C314E2DC1E67DF513116895CD006BFD9EE41696CF70F862F",
  };
  const outPath = path.join(ROOT, "deployments", "drill-finalize.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
}

main().catch((err: unknown) => {
  console.error("\nDrill finalize run failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
