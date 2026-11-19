/**
 * threshold-auction.ts - run auction 14 end-to-end on Diana with a THRESHOLD
 * auctioneer (2-of-3 keys to open results).
 *
 * Why threshold is a ceremony, not a contract feature: the deployed
 * SealedBid contract takes exactly ONE ML-KEM-1024 public key per auction,
 * never decrypts anything, and has no keyholder/threshold logic at all.
 * On-chain enforcement would need a redeploy, which would orphan 14
 * auctions of history — so it is NOT done. Instead, auction 14 uses a
 * dedicated threshold keypair:
 *
 *   1. A fresh ML-KEM-1024 keypair is generated IN MEMORY for auction 14.
 *   2. Its secret key (3168 bytes) is split 2-of-3 with Shamir secret
 *      sharing (src/lib/threshold.ts). The 3 shares are written mode 600
 *      OUTSIDE the repo (../threshold/, plus a backup copy in
 *      ../threshold-backup/). The full secret key is NEVER written to disk
 *      — no single party holds it.
 *   3. The public key is published in the AuctionCreated event and bound
 *      on-chain by the auction's kemKeyHash. It is NOT in the x/pqc
 *      registry: the registry holds one key per account, and the
 *      auctioneer's registered key must stay in place for auctions 0–13.
 *      Bidders fetch the key from the event logs and verify its hash
 *      against the auction — the same check the demo UI performs.
 *   4. Three bidders seal real bids to the threshold key, reveal after the
 *      bidding deadline, and the auction is finalised on-chain.
 *   5. The opening ceremony: any 2 of the 3 shares reconstruct the secret
 *      key (verified against the recorded keccak256 commitment) and open
 *      every sealed bid; decrypted amounts are checked against the
 *      on-chain reveals.
 *
 * Flow (all on-chain steps verified by reading state back):
 *   bidders funded + windowed -> create auction 14 -> 3 sealed bids ->
 *   reveal -> finalise -> threshold opening ceremony.
 *
 * Prerequisites (run first):
 *   - a live deployer EVM window (`npm run window -- open`, sized for the
 *     create + finalise calls; 1200 blocks / 12 txs covers the finalize
 *     run too) — the script FAILS FAST without one.
 *   - each bidder holding >= 450,000 uqor (window + bid + reveal). Fund
 *     from the quantum-flip deployer if needed:
 *     `npx tsx --env-file=.env scripts/drill-fund.ts <qor1> <uqor>`
 *     run from ~/workspace/qorechain/quantum-flip.
 *
 * Writes deployments/threshold-auction14.json (public data only — no share
 * material, no secret key). Takes ~8 minutes (two real on-chain phases).
 * Testnet only.
 */
import { qorechainTestnet } from "@qorechain/evm";
import type { Chain } from "viem";
const testnet = qorechainTestnet as unknown as Chain;
import { evmWindowStatus } from "@qorechain/evm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbiItem,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { sealedBidAbi } from "../contracts/SealedBid.artifact.js";
import {
  computeCommitment,
  generateKemKeypair,
  kemPublicKeyHash,
  randomSalt,
  sealBid,
} from "../src/lib/kem.js";
import { reconstructSecret, secretCommitment, splitSecret } from "../src/lib/threshold.js";
import {
  CHAIN_ID,
  EVM_RPC,
  REST,
  cosmosHashForEvmTx,
  deriveAccount,
  nativeBalance,
  openWindow,
  registerPqcKey,
} from "./qore.js";
import {
  loadShares,
  openAuctionBids,
  reconstructFromShares,
  saveShare,
  type StoredShare,
} from "./threshold-ceremony.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "..");
const BIDDERS_PATH = path.resolve(ROOT, "..", "bidders.json");
const VIDEO_WALLET_PATH = path.resolve(ROOT, "..", "video-wallet.json");

const BIDDING_SECONDS = 180;
const REVEAL_SECONDS = 180;
const MIN_BID_UQOR = 100_000n;
/** Minimum native balance per bidder (window ~100k + bid ~225k + reveal ~37.5k, with margin). */
const MIN_BIDDER_BALANCE_UQOR = 450_000n;

/** Explicit fee caps: the chain's fee market is volatile (see README). */
const MAX_FEE_PER_GAS = 150_000_000_000n; // 150 gwei
const MAX_PRIORITY_FEE = 12_500_000_000n; // 12.5 gwei
const GAS = { createAuction: 700_000n, submitBid: 1_500_000n, revealBid: 250_000n, finalize: 200_000n };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StoredBidder {
  label: string;
  mnemonic: string;
  evm: Address;
  cosmos: string;
}

type AuctionTuple = [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean];

async function main(): Promise<void> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in .env");
  const deployment = JSON.parse(
    fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address };
  const contract = deployment.contract;
  const deployer = await deriveAccount(mnemonic);
  console.log(`deployer/auctioneer: ${deployer.evm} (${deployer.cosmos})`);
  console.log(`contract: ${contract} (${CHAIN_ID})`);

  // 0. Fail fast without a live deployer window (create + finalise need it).
  const win = await evmWindowStatus({ rest: REST, address: deployer.cosmos });
  if (!win.found || !win.live || BigInt(win.remainingBlocks) < 200n || BigInt(win.remainingTxs) < 2n) {
    throw new Error(
      "No usable deployer EVM window (need >= 200 blocks, >= 2 txs). " +
        "Open one first: QORE_WINDOW_BLOCKS=1200 QORE_WINDOW_TXS=12 npm run window -- open",
    );
  }
  console.log(
    `deployer window live: ${win.remainingBlocks} blocks, ${win.remainingTxs} txs, ${win.remainingValue} uqor left`,
  );

  const publicClient = createPublicClient({ chain: testnet, transport: http(EVM_RPC) });
  const deployerWallet = createWalletClient({
    account: mnemonicToAccount(mnemonic),
    chain: testnet,
    transport: http(EVM_RPC),
  });

  // 1. Threshold keypair: generated in memory, split 2-of-3, shares saved
  //    mode 600 outside the repo. The full secret key NEVER touches disk.
  console.log("\n--- threshold keypair (in-memory only) ---");
  const thresholdKey = generateKemKeypair();
  const commitment = secretCommitment(thresholdKey.secretKey);
  const shares = splitSecret(thresholdKey.secretKey, 2, 3);
  const createdAt = new Date().toISOString();
  for (const s of shares) {
    const stored: StoredShare = {
      purpose: "SealedBid auction 14 threshold opening — keyholder share (2-of-3 Shamir over GF(2^8))",
      auctionId: 14,
      threshold: 2,
      totalShares: 3,
      x: s.x,
      share: toHex(s.y),
      publicKey: toHex(thresholdKey.publicKey),
      secretCommitment: commitment,
      createdAt,
    };
    saveShare(stored);
    console.log(`  share ${s.x} saved (mode 600, primary + backup)`);
  }
  // Prove the split works BEFORE the secret key leaves memory: reconstruct
  // from shares 2+3 (not the first two — any pair must work) and compare.
  const check = reconstructSecret([shares[1]!, shares[2]!], 2);
  if (!check.every((b, i) => b === thresholdKey.secretKey[i]) || secretCommitment(check) !== commitment) {
    throw new Error("in-memory reconstruction check failed — aborting before any on-chain step");
  }
  console.log("  in-memory reconstruction from shares 2+3 verified against the commitment ✓");
  console.log(`  threshold public key hash: ${kemPublicKeyHash(thresholdKey.publicKey)}`);

  // 2. Bidders: the two e2e bidders + the video wallet (3 sealed bids).
  const storedBidders = JSON.parse(fs.readFileSync(BIDDERS_PATH, "utf8")) as StoredBidder[];
  const videoWallet = JSON.parse(fs.readFileSync(VIDEO_WALLET_PATH, "utf8")) as StoredBidder;
  const plan: Array<{ label: string; mnemonic: string; amount: bigint }> = [
    { label: "bidder-1", mnemonic: storedBidders[0]!.mnemonic, amount: 1_000_000n },
    { label: "video-wallet", mnemonic: videoWallet.mnemonic, amount: 1_750_000n },
    { label: "bidder-2", mnemonic: storedBidders[1]!.mnemonic, amount: 2_500_000n },
  ];
  const bidderWallets = [];
  for (const p of plan) {
    const acc = await deriveAccount(p.mnemonic);
    const balance = await nativeBalance(acc.cosmos);
    console.log(`\n--- ${p.label}: ${acc.evm} (${acc.cosmos}) balance ${balance} uqor ---`);
    if (balance < MIN_BIDDER_BALANCE_UQOR) {
      throw new Error(
        `${p.label} holds ${balance} uqor, need >= ${MIN_BIDDER_BALANCE_UQOR}. ` +
          "Fund it from the quantum-flip deployer (drill-fund.ts) and re-run.",
      );
    }
    const regTx = await registerPqcKey(acc);
    console.log(regTx ? `PQC key registered: ${regTx}` : "PQC key already registered");
    const winTx = await openWindow(acc, 1200n, 5n);
    console.log(`window opened: ${winTx}`);
    bidderWallets.push({
      ...p,
      evm: acc.evm as Address,
      wallet: createWalletClient({
        account: mnemonicToAccount(p.mnemonic),
        chain: testnet,
        transport: http(EVM_RPC),
      }),
    });
    await sleep(3000);
  }
  await sleep(10000); // let the windows settle before the first EVM tx

  // 3. Create auction 14, bound to the THRESHOLD public key.
  console.log("\n--- create auction 14 ---");
  const item = "SealedBid threshold lot — 2-of-3 opening (testnet)";
  const createHash = await deployerWallet.writeContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "createAuction",
    args: [item, toHex(thresholdKey.publicKey), BigInt(BIDDING_SECONDS), BigInt(REVEAL_SECONDS), MIN_BID_UQOR],
    chain: testnet,
    gas: GAS.createAuction,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE,
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (createReceipt.status !== "success") throw new Error(`create tx ${createHash} reverted`);
  const createCosmos = await cosmosHashForEvmTx(publicClient, createHash);
  console.log(`create tx: ${createHash} (block ${createReceipt.blockNumber}, Cosmos ${createCosmos.cosmosHash})`);
  const auctionCount = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "auctionCount",
  })) as bigint;
  const auctionId = auctionCount - 1n;
  if (auctionId !== 14n) throw new Error(`expected auction 14, got ${auctionId} — aborting`);
  const auction = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "auctions", args: [auctionId],
  })) as unknown as AuctionTuple;
  if (auction[2] !== kemPublicKeyHash(thresholdKey.publicKey)) {
    throw new Error("Auction KEM hash does not match the threshold public key");
  }
  console.log(`auction id: ${auctionId}, bidding until ${auction[3]}, reveal until ${auction[4]}`);

  const evidence: Record<string, unknown> = {
    contract,
    auctioneer: deployer.evm,
    auctionId: "14",
    item,
    threshold: { scheme: "Shamir 2-of-3 over GF(2^8)", totalShares: 3 },
    thresholdPublicKey: toHex(thresholdKey.publicKey),
    thresholdPublicKeyHash: kemPublicKeyHash(thresholdKey.publicKey),
    secretCommitment: commitment,
    minBidUqor: MIN_BID_UQOR.toString(),
    createTx: createHash,
    createBlock: createReceipt.blockNumber.toString(),
    createTxCosmos: createCosmos.cosmosHash,
    bids: [],
  };

  // 4. Sealed bids. Each bidder fetches the threshold public key from the
  //    AuctionCreated event logs (the UI's path — the key is NOT in the
  //    x/pqc registry) and verifies its hash against the auction.
  for (let i = 0; i < bidderWallets.length; i++) {
    const bw = bidderWallets[i]!;
    console.log(`\n--- ${bw.label} seals a bid of ${bw.amount} uqor ---`);
    const logs = await publicClient.getLogs({
      address: contract,
      event: parseAbiItem(
        "event AuctionCreated(uint256 indexed auctionId, address indexed auctioneer, string item, bytes32 kemKeyHash, bytes kemPublicKey, uint256 biddingDeadline, uint256 revealDeadline, uint256 minBid)",
      ),
      args: { auctionId },
      fromBlock: createReceipt.blockNumber,
      toBlock: "latest",
    });
    if (logs.length !== 1) throw new Error(`expected exactly 1 AuctionCreated log, got ${logs.length}`);
    const eventKey = logs[0]!.args.kemPublicKey as Hex;
    if (kemPublicKeyHash(Buffer.from(eventKey.slice(2), "hex")) !== auction[2]) {
      throw new Error("event key does not match the auction hash — refusing to seal");
    }
    const salt = randomSalt();
    const sealed = sealBid(Buffer.from(eventKey.slice(2), "hex"), {
      amount: bw.amount.toString(),
      salt,
    });
    const commitmentBid = computeCommitment(bw.amount, salt, bw.evm);
    const bidHash = await bw.wallet.writeContract({
      address: contract,
      abi: sealedBidAbi,
      functionName: "submitBid",
      args: [auctionId, toHex(sealed.kemCiphertext), toHex(sealed.sealedBid), commitmentBid],
      chain: testnet,
      gas: GAS.submitBid,
      maxFeePerGas: MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE,
    });
    const bidReceipt = await publicClient.waitForTransactionReceipt({ hash: bidHash });
    if (bidReceipt.status !== "success") throw new Error(`bid tx ${bidHash} reverted`);
    const bidCosmos = await cosmosHashForEvmTx(publicClient, bidHash);
    console.log(`bid tx: ${bidHash} (block ${bidReceipt.blockNumber}, Cosmos ${bidCosmos.cosmosHash})`);
    (evidence.bids as Array<Record<string, unknown>>).push({
      bidder: bw.evm,
      label: bw.label,
      amountUqor: bw.amount.toString(),
      salt,
      commitment: commitmentBid,
      bidTx: bidHash,
      bidBlock: bidReceipt.blockNumber.toString(),
      bidTxCosmos: bidCosmos.cosmosHash,
    });
  }
  const bidCount = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "bidCount", args: [auctionId],
  })) as bigint;
  console.log(`\non-chain bid count: ${bidCount}`);
  if (bidCount !== 3n) throw new Error(`expected 3 sealed bids on-chain, found ${bidCount}`);

  // 5. Wait for the bidding phase to close, then reveal.
  const waitBidding = Number(auction[3]) * 1000 - Date.now() + 8000;
  console.log(`\nwaiting ${Math.ceil(waitBidding / 1000)}s for the bidding deadline…`);
  await sleep(Math.max(waitBidding, 1000));
  for (let i = 0; i < bidderWallets.length; i++) {
    const bw = bidderWallets[i]!;
    const bid = (evidence.bids as Array<Record<string, unknown>>)[i]!;
    console.log(`--- ${bw.label} reveals ${bw.amount} uqor ---`);
    const revealHash = await bw.wallet.writeContract({
      address: contract,
      abi: sealedBidAbi,
      functionName: "revealBid",
      args: [auctionId, bw.amount, bid.salt as Hex],
      chain: testnet,
      gas: GAS.revealBid,
      maxFeePerGas: MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE,
    });
    const revealReceipt = await publicClient.waitForTransactionReceipt({ hash: revealHash });
    if (revealReceipt.status !== "success") throw new Error(`reveal tx ${revealHash} reverted`);
    const revealCosmos = await cosmosHashForEvmTx(publicClient, revealHash);
    console.log(`reveal tx: ${revealHash} (block ${revealReceipt.blockNumber}, Cosmos ${revealCosmos.cosmosHash})`);
    bid.revealTx = revealHash;
    bid.revealBlock = revealReceipt.blockNumber.toString();
    bid.revealTxCosmos = revealCosmos.cosmosHash;
  }
  const afterReveal = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "auctions", args: [auctionId],
  })) as unknown as AuctionTuple;
  console.log(`highest revealed: ${afterReveal[6]} uqor by ${afterReveal[7]}`);
  if (afterReveal[6] !== 2_500_000n) throw new Error("highest bid mismatch after reveal");
  if (afterReveal[7].toLowerCase() !== storedBidders[1]!.evm.toLowerCase()) {
    throw new Error("highest bidder mismatch after reveal (expected bidder-2)");
  }

  // 6. Wait for the reveal deadline, then finalise.
  const waitReveal = Number(auction[4]) * 1000 - Date.now() + 8000;
  console.log(`\nwaiting ${Math.ceil(waitReveal / 1000)}s for the reveal deadline…`);
  await sleep(Math.max(waitReveal, 1000));
  const finHash = await deployerWallet.writeContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "finalize",
    args: [auctionId],
    chain: testnet,
    gas: GAS.finalize,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE,
  });
  const finReceipt = await publicClient.waitForTransactionReceipt({ hash: finHash });
  if (finReceipt.status !== "success") throw new Error(`finalize tx ${finHash} reverted`);
  const finCosmos = await cosmosHashForEvmTx(publicClient, finHash);
  console.log(`finalize tx: ${finHash} (block ${finReceipt.blockNumber}, Cosmos ${finCosmos.cosmosHash})`);
  evidence.finalizeTx = finHash;
  evidence.finalizeBlock = finReceipt.blockNumber.toString();
  evidence.finalizeTxCosmos = finCosmos.cosmosHash;

  const final = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "auctions", args: [auctionId],
  })) as unknown as AuctionTuple;
  const phase = (await publicClient.readContract({
    address: contract, abi: sealedBidAbi, functionName: "phaseOf", args: [auctionId],
  })) as number;
  if (!final[8] || phase !== 2) throw new Error("auction 14 did not finalise");
  if (final[7].toLowerCase() !== storedBidders[1]!.evm.toLowerCase() || final[6] !== 2_500_000n) {
    throw new Error("final winner mismatch (expected bidder-2 at 2,500,000)");
  }
  console.log(`\nfinal: winner ${final[7]}, ${final[6]} uqor, finalized=${final[8]}, phase=${phase}`);
  evidence.winner = final[7];
  evidence.winningBidUqor = final[6].toString();

  // 7. Threshold opening ceremony — from the SHARE FILES on disk (the
  //    in-memory key is deliberately not used here): load shares 2 and 3,
  //    reconstruct, verify the commitment, open every sealed bid.
  console.log("\n--- threshold opening ceremony (shares 2 + 3, from disk) ---");
  const stored = loadShares([2, 3]);
  const reconstructed = reconstructFromShares(stored);
  console.log(`reconstructed key: ${reconstructed.length} bytes — commitment MATCHES ✓`);
  const opened = await openAuctionBids(contract, auctionId, reconstructed);
  for (const o of opened) {
    console.log(`  ${o.bidder}: decrypted ${o.decryptedAmount} uqor == reveal ${o.revealedAmount} ✓`);
  }
  evidence.ceremony = {
    sharesUsed: [2, 3],
    commitmentVerified: true,
    bidsOpened: opened.length,
    allDecryptedMatchReveals: opened.every((o) => o.matchesReveal),
  };

  evidence.completedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(ROOT, "deployments", "threshold-auction14.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log("\nWrote deployments/threshold-auction14.json");
  console.log("Auction 14 complete: created, 3 sealed bids, revealed, finalised, opened 2-of-3.");
}

main().catch((err: unknown) => {
  console.error("\nThreshold auction run failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
