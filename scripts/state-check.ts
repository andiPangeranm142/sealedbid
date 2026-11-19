/**
 * state-check.ts - read-only dump of SealedBid auction state (no secrets needed).
 * Usage: npx tsx scripts/state-check.ts [ids...]  (default: all auctions)
 */
import { qorechainTestnet } from "@qorechain/evm";
import type { Chain } from "viem";
const testnet = qorechainTestnet as unknown as Chain;
import { createPublicClient, http, type Address, type Hex } from "viem";
import { sealedBidAbi } from "../contracts/SealedBid.artifact.js";
import { EVM_RPC } from "./qore.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "..");
const deployment = JSON.parse(
  fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"),
) as { contract: Address };
const contract = deployment.contract;

type AuctionTuple = [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean];

async function main(): Promise<void> {
  const pc = createPublicClient({ chain: testnet, transport: http(EVM_RPC) });
  const block = await pc.getBlockNumber();
  const count = (await pc.readContract({
    address: contract, abi: sealedBidAbi, functionName: "auctionCount",
  })) as bigint;
  console.log(`contract: ${contract}`);
  console.log(`latest block: ${block} | auctionCount: ${count}`);
  const ids = process.argv.slice(2).length
    ? process.argv.slice(2).map((s) => BigInt(s))
    : Array.from({ length: Number(count) }, (_, i) => BigInt(i));
  for (const id of ids) {
    const a = (await pc.readContract({
      address: contract, abi: sealedBidAbi, functionName: "auctions", args: [id],
    })) as unknown as AuctionTuple;
    const phase = (await pc.readContract({
      address: contract, abi: sealedBidAbi, functionName: "phaseOf", args: [id],
    })) as number;
    const bidCount = (await pc.readContract({
      address: contract, abi: sealedBidAbi, functionName: "bidCount", args: [id],
    })) as bigint;
    const bidders = (await pc.readContract({
      address: contract, abi: sealedBidAbi, functionName: "getBidders", args: [id],
    })) as Address[];
    const phaseName = ["Bidding", "Revealing", "Finalized"][phase];
    console.log(
      `\n#${id} "${a[1]}" | auctioneer ${a[0]} | phase ${phaseName} | finalized=${a[8]}`,
    );
    console.log(
      `  biddingDeadline=${a[3]} revealDeadline=${a[4]} minBid=${a[5]} | bids=${bidCount} | highest=${a[6]} by ${a[7]}`,
    );
    for (const b of bidders) {
      const bid = (await pc.readContract({
        address: contract, abi: sealedBidAbi, functionName: "bids", args: [id, b],
      })) as unknown as [Hex, Hex, Hex, bigint, boolean];
      console.log(`  bidder ${b}: revealed=${bid[4]} amount=${bid[3]} commitment=${bid[2].slice(0, 18)}…`);
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
