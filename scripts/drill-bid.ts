/**
 * drill-bid.ts - Q-Day Drill day (18 Nov 2026) bid for SealedBid.
 *
 * The drill bidder (fresh account, ../.env.drill) places ONE sealed bid of
 * 500,000 uqor on the drill auction (id 13, bidding open until 20 Nov 2026
 * 00:00 UTC, min bid 100,000 uqor). The bid is sealed client-side exactly
 * like the e2e flow (ML-KEM-1024 + AES-256-GCM, commitment
 * keccak256(amount, salt, bidder)); the auctioneer's KEM key is fetched
 * from the on-chain registry and verified against the auction's recorded
 * hash before sealing.
 *
 * Funds: submitBid is NOT payable — no funds move through the contract and
 * no bid amount is locked (amounts are recorded in uqor units; settlement
 * is off-chain). The bid costs gas only, so the drill account's 2 QOR
 * funding is far more than enough.
 *
 * DO NOT run before drill day. The drill-day cron opens the bidder's EVM
 * window first, then runs this script:
 *
 *   cd ~/workspace/qorechain/sealedbid/repo
 *   npx tsx --env-file=../.env.drill scripts/window.ts open
 *   npx tsx --env-file=../.env.drill scripts/drill-bid.ts
 *
 * The script prints the bid transaction hash (EVM + Cosmos) — that hash is
 * the drill proof submitted on the SealedBid project page. It also saves
 * the bid secret (amount + salt) to ../drill-bid.json (mode 600, outside
 * the repo) so the bid can be revealed during the reveal phase (20–21 Nov)
 * if wanted; the salt is needed for revealBid and cannot be recovered
 * otherwise.
 */
import { qorechainTestnet } from "@qorechain/evm";
import type { Chain } from "viem";

// Same viem/SDK type-drift bridge as scripts/e2e.ts.
const testnet = qorechainTestnet as unknown as Chain;
import { fetchKemKey } from "@qorechain/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { sealedBidAbi } from "../contracts/SealedBid.artifact.js";
import {
  computeCommitment,
  kemPublicKeyHash,
  randomSalt,
  sealBid,
} from "../src/lib/kem.js";
import {
  CHAIN_ID,
  EVM_RPC,
  REST,
  cosmosHashForEvmTx,
  deriveAccount,
  nativeBalance,
} from "./qore.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "..");
const BID_SECRET_PATH = path.resolve(ROOT, "..", "drill-bid.json");

/** Drill auction (created 16 Nov 2026): bidding until 20 Nov 00:00 UTC. */
const AUCTION_ID = 13n;
/** Bid amount, in uqor units (min bid is 100,000 uqor). */
const BID_AMOUNT_UQOR = 500_000n;
/** Deployer/auctioneer (EVM + Cosmos) — the KEM key owner. */
const AUCTIONEER_EVM = "0xB5e7E335226D56Ca2Bd38FDEb18169A8C004185E" as Address;
const AUCTIONEER_COSMOS = "qor1khn7xdfzd4tv527n3l0trqtf4rqqgxz7wh43cr";
/** Minimum balance to attempt the bid (gas headroom; the bid locks no funds). */
const MIN_BALANCE_UQOR = 200_000n;

async function main(): Promise<void> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in ../.env.drill");
  const deployment = JSON.parse(
    fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address };
  const contract = deployment.contract;

  const bidder = await deriveAccount(mnemonic);
  console.log(`contract: ${contract}`);
  console.log(`chain: ${CHAIN_ID} (EVM ${EVM_RPC})`);
  console.log(`drill bidder: ${bidder.evm} (${bidder.cosmos})`);

  const balance = await nativeBalance(bidder.cosmos);
  console.log(`bidder balance: ${balance} uqor`);
  if (balance < MIN_BALANCE_UQOR) {
    throw new Error(`Bidder balance ${balance} uqor is below the ${MIN_BALANCE_UQOR} uqor minimum — top up first.`);
  }

  const publicClient = createPublicClient({ chain: testnet, transport: http(EVM_RPC) });
  const bidderWallet = createWalletClient({
    account: mnemonicToAccount(mnemonic),
    chain: testnet,
    transport: http(EVM_RPC),
  });

  // 1. Read the auction and verify it is open for bidding.
  // auctions tuple: [auctioneer, item, kemKeyHash, biddingDeadline,
  // revealDeadline, minBid, highestBid, highestBidder, finalized]
  const auction = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "auctions",
    args: [AUCTION_ID],
  })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean];
  if (auction[0].toLowerCase() !== AUCTIONEER_EVM.toLowerCase()) {
    throw new Error(`Auction ${AUCTION_ID} auctioneer ${auction[0]} is not the expected ${AUCTIONEER_EVM}`);
  }
  console.log(`auction ${AUCTION_ID}: ${auction[1]}`);
  console.log(
    `bidding until ${new Date(Number(auction[3]) * 1000).toISOString()}, ` +
      `reveal until ${new Date(Number(auction[4]) * 1000).toISOString()}, min bid ${auction[5]} uqor`,
  );
  if (auction[8]) throw new Error(`Auction ${AUCTION_ID} is already finalised`);
  if (BigInt(Math.floor(Date.now() / 1000)) >= auction[3]) {
    throw new Error(`Bidding on auction ${AUCTION_ID} is closed`);
  }
  if (BID_AMOUNT_UQOR < auction[5]) {
    throw new Error(`Bid ${BID_AMOUNT_UQOR} uqor is below the minimum ${auction[5]} uqor`);
  }
  const alreadyBid = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "hasBid",
    args: [AUCTION_ID, bidder.evm as Address],
  })) as boolean;
  if (alreadyBid) throw new Error("Drill bidder has already bid on this auction (one bid per bidder)");

  // 2. Fetch the auctioneer's KEM key from the registry and verify it
  // against the auction's recorded hash before sealing (same check as e2e).
  const fetched = await fetchKemKey({ rest: REST, address: AUCTIONEER_COSMOS });
  if (!fetched.found || !fetched.key) throw new Error("No KEM key in the registry for the auctioneer");
  if (kemPublicKeyHash(fetched.key.publicKey) !== auction[2]) {
    throw new Error("Registry key does not match the auction hash — refusing to seal");
  }
  console.log("KEM key: fetched from the registry and matches the auction hash.");

  // 3. Seal the bid client-side and submit it.
  const salt = randomSalt();
  const sealed = sealBid(fetched.key.publicKey, { amount: BID_AMOUNT_UQOR.toString(), salt });
  const commitment = computeCommitment(BID_AMOUNT_UQOR, salt, bidder.evm as Address);
  console.log(`sealing bid of ${BID_AMOUNT_UQOR} uqor (commitment ${commitment})…`);
  const bidHash = await bidderWallet.writeContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "submitBid",
    args: [AUCTION_ID, toHex(sealed.kemCiphertext), toHex(sealed.sealedBid), commitment],
    chain: testnet,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: bidHash });
  console.log(`bid tx: ${bidHash} (status ${receipt.status})`);
  if (receipt.status !== "success") throw new Error("submitBid reverted");

  // 4. Verify the bid landed on-chain.
  const hasBidAfter = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "hasBid",
    args: [AUCTION_ID, bidder.evm as Address],
  })) as boolean;
  const stored = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "bids",
    args: [AUCTION_ID, bidder.evm as Address],
  })) as unknown as [Hex, Hex, Hex, bigint, boolean];
  if (!hasBidAfter || stored[2] !== commitment) {
    throw new Error("Sealed bid not found on-chain or commitment mismatch");
  }
  const bidCount = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "bidCount",
    args: [AUCTION_ID],
  })) as bigint;
  console.log(`verified on-chain: hasBid=true, commitment matches, bidCount=${bidCount}`);
  const cosmos = await cosmosHashForEvmTx(publicClient, bidHash);
  console.log(`bid tx (Cosmos): ${cosmos.cosmosHash}`);

  // 5. Save the bid secret (outside the repo, mode 600) for a later reveal.
  fs.writeFileSync(
    BID_SECRET_PATH,
    `${JSON.stringify(
      {
        purpose: "SealedBid Q-Day Drill bid secret — needed for revealBid during 20–21 Nov. Keep private until the reveal.",
        auctionId: AUCTION_ID.toString(),
        bidder: bidder.evm,
        amountUqor: BID_AMOUNT_UQOR.toString(),
        salt,
        commitment,
        bidTx: bidHash,
        bidTxCosmos: cosmos.cosmosHash,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(`bid secret saved to ${BID_SECRET_PATH} (mode 600)`);
  console.log("\nDRILL BID SUBMITTED AND VERIFIED.");
  console.log(`DRILL PROOF HASH (EVM): ${bidHash}`);
  console.log(`DRILL PROOF HASH (Cosmos): ${cosmos.cosmosHash}`);
}

main().catch((err: unknown) => {
  console.error("\nDrill bid failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
