/**
 * drill-reveal.ts - reveal the Q-Day Drill bid (auction 13) during the
 * reveal phase (20–21 Nov 2026).
 *
 * Reads the bid secret (amount + salt) from ../drill-bid.json (mode 600,
 * outside the repo) and calls revealBid(13, amount, salt) from the drill
 * bidder account (../.env.drill). The salt is NEVER printed.
 *
 * Usage (window must be open first):
 *   cd ~/workspace/qorechain/sealedbid/repo
 *   npx tsx --env-file=../.env.drill scripts/window.ts open
 *   npx tsx --env-file=../.env.drill scripts/drill-reveal.ts
 *
 * Verifies on-chain (revealed=true, revealedAmount=500,000 uqor, highest
 * bid) and decrypts the sealed bid off-chain with the auctioneer's ML-KEM
 * secret key (../auctioneer-kem.json, mode 600), checking the decrypted
 * amount against the on-chain reveal. Records the reveal tx (EVM + Cosmos)
 * and block in deployments/drill-bid.json.
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
import { computeCommitment, unsealBid } from "../src/lib/kem.js";
import {
  CHAIN_ID,
  EVM_RPC,
  cosmosHashForEvmTx,
  deriveAccount,
  nativeBalance,
} from "./qore.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "..");
const AUCTION_ID = 13n;
const SECRET_PATH = path.resolve(ROOT, "..", "drill-bid.json");
const KEM_PATH = path.resolve(ROOT, "..", "auctioneer-kem.json");
const RECORD_PATH = path.join(ROOT, "deployments", "drill-bid.json");

async function main(): Promise<void> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in ../.env.drill");
  const secret = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8")) as {
    auctionId: number | string;
    bidder: Address;
    amountUqor: number | string;
    salt: Hex;
    commitment: Hex;
  };
  if (Number(secret.auctionId) !== 13) throw new Error(`drill-bid.json is for auction ${secret.auctionId}, expected 13`);
  const amount = BigInt(secret.amountUqor);
  const salt = secret.salt as Hex;

  const deployment = JSON.parse(
    fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address };
  const contract = deployment.contract;
  const bidder = await deriveAccount(mnemonic);
  if (bidder.evm.toLowerCase() !== secret.bidder.toLowerCase()) {
    throw new Error(`drill wallet ${bidder.evm} does not match drill bidder ${secret.bidder}`);
  }
  const balance = await nativeBalance(bidder.cosmos);
  console.log(`contract: ${contract}`);
  console.log(`chain: ${CHAIN_ID} (EVM ${EVM_RPC})`);
  console.log(`drill bidder: ${bidder.evm} (${bidder.cosmos}), balance ${balance} uqor`);

  const publicClient = createPublicClient({ chain: testnet, transport: http(EVM_RPC) });
  const wallet = createWalletClient({
    account: mnemonicToAccount(mnemonic),
    chain: testnet,
    transport: http(EVM_RPC),
  });

  // 1. Phase + commitment check before revealing.
  const auction = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "auctions",
    args: [AUCTION_ID],
  })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean];
  const phase = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "phaseOf",
    args: [AUCTION_ID],
  })) as number;
  console.log(
    `auction 13: "${auction[1]}" phase=${["Bidding", "Revealing", "Finalized"][phase]} ` +
      `reveal until ${new Date(Number(auction[4]) * 1000).toISOString()}`,
  );
  if (phase !== 1) throw new Error(`Auction 13 is not in the reveal phase (phase=${phase})`);
  const stored = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "bids",
    args: [AUCTION_ID, bidder.evm],
  })) as unknown as [Hex, Hex, Hex, bigint, boolean];
  if (stored[4]) throw new Error("Bid already revealed — refusing to reveal twice");
  if (stored[2].toLowerCase() !== secret.commitment.toLowerCase()) {
    throw new Error("On-chain commitment does not match drill-bid.json");
  }
  const localCommitment = computeCommitment(amount, salt, bidder.evm);
  if (localCommitment.toLowerCase() !== secret.commitment.toLowerCase()) {
    throw new Error("Local commitment (amount + salt + bidder) does not match — wrong secret");
  }
  console.log("commitment verified against on-chain record; revealing…");

  // 2. Reveal.
  const revealHash = await wallet.writeContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "revealBid",
    args: [AUCTION_ID, amount, salt],
    chain: testnet,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: revealHash });
  if (receipt.status !== "success") throw new Error(`reveal tx ${revealHash} reverted`);
  const { cosmosHash, block } = await cosmosHashForEvmTx(publicClient, revealHash);
  console.log(`reveal tx: ${revealHash} (block ${block}, status success)`);
  console.log(`reveal tx (Cosmos): ${cosmosHash}`);

  // 3. Verify on-chain.
  const after = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "bids",
    args: [AUCTION_ID, bidder.evm],
  })) as unknown as [Hex, Hex, Hex, bigint, boolean];
  if (!after[4] || after[3] !== amount) {
    throw new Error(`On-chain verification failed: revealed=${after[4]} amount=${after[3]}`);
  }
  const afterAuction = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "auctions",
    args: [AUCTION_ID],
  })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean];
  console.log(
    `verified on-chain: revealed=true, revealedAmount=${after[3]} uqor, ` +
      `highest=${afterAuction[6]} uqor by ${afterAuction[7]}`,
  );
  if (afterAuction[6] !== amount || afterAuction[7].toLowerCase() !== bidder.evm.toLowerCase()) {
    throw new Error("Highest bid mismatch after reveal");
  }

  // 4. Auctioneer decrypts the sealed bid off-chain and matches the reveal.
  const kem = JSON.parse(fs.readFileSync(KEM_PATH, "utf8")) as { secretKey: Hex };
  const opened = unsealBid(
    Buffer.from(kem.secretKey.slice(2), "hex"),
    Buffer.from(after[0].slice(2), "hex"),
    Buffer.from(after[1].slice(2), "hex"),
  );
  console.log(
    `decrypted (auctioneer, off-chain): amount=${opened.amount} ` +
      `(on-chain reveal: ${after[3]}, revealed=${after[4]})`,
  );
  if (BigInt(opened.amount) !== amount) {
    throw new Error("Decrypted amount does not match the on-chain reveal");
  }
  console.log("decrypted amount matches on-chain reveal ✓");

  // 5. Record the reveal in deployments/drill-bid.json.
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8")) as Record<string, unknown>;
  record.action = "drill-bid+reveal";
  record.revealTx = revealHash;
  record.revealTxCosmos = cosmosHash;
  record.revealBlock = block;
  record.revealedAmountUqor = Number(amount);
  record.revealedAt = new Date().toISOString();
  record.decryptedAmountUqor = Number(opened.amount);
  record.windowOpenTxCosmos = process.env.DRILL_WINDOW_TX ?? undefined;
  fs.writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + "\n");
  console.log(`record updated: ${RECORD_PATH}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
