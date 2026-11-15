/**
 * e2e.ts - run a REAL end-to-end sealed-bid auction on the Diana testnet.
 *
 * Flow (all on-chain, all verified by reading state back):
 *   1. Two fresh bidder accounts are generated (../bidders.json, mode 600,
 *      outside the repo), funded from the deployer, ML-DSA-registered
 *      (each account's first transaction) and given EVM windows.
 *   2. The deployer (auctioneer) creates an auction bound by hash to its
 *      chain-registered ML-KEM-1024 public key (register it first:
 *      `npm run register-kem -- register`).
 *   3. Each bidder fetches the auctioneer's KEM key, seals a bid
 *      client-side (ML-KEM-1024 + AES-256-GCM) and submits it with a
 *      commitment. The ciphertext on-chain reveals nothing.
 *   4. After the bidding deadline the bidders reveal (amount + salt); the
 *      contract verifies each reveal against its commitment.
 *   5. After the reveal deadline the auction is finalised; the highest
 *      revealed bid wins. The auctioneer decrypts the sealed bids
 *      off-chain and the decrypted amounts are checked against the
 *      on-chain reveals.
 *
 * Writes deployments/e2e.json with every transaction hash (EVM + Cosmos)
 * and the verified outcome. Takes ~6 minutes (two real on-chain phases).
 *
 * Prerequisites: deployments/testnet.json (deploy first), the deployer's
 * KEM key registered on-chain, and a live deployer EVM window
 * (`npm run window open`) with at least 2 spare transactions.
 */
import { qorechainTestnet } from "@qorechain/evm";
import type { Chain } from "viem";

// @qorechain/evm was typed against an older viem whose
// PrepareTransactionRequestPhase had three phases; viem 2.57 added a fourth
// ("afterFillTransactionError"), so the SDK's chain type no longer satisfies
// viem's Chain. The runtime chain object carries no prepareTransactionRequest
// at all, so this cast changes nothing at runtime — it only bridges the
// type-level drift between the SDK and this repo's viem.
const testnet = qorechainTestnet as unknown as Chain;
import { fetchKemKey } from "@qorechain/sdk";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";
import { generateMnemonic } from "viem/accounts";
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
  generateKemKeypair,
  kemPublicKeyHash,
  randomSalt,
  sealBid,
  unsealBid,
} from "../src/lib/kem.js";
import {
  CHAIN_ID,
  EVM_RPC,
  REST,
  cosmosHashForEvmTx,
  deriveAccount,
  fundNative,
  nativeBalance,
  openWindow,
  registerPqcKey,
} from "./qore.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "..");
const BIDDERS_PATH = path.resolve(ROOT, "..", "bidders.json");
const KEM_PATH = path.resolve(ROOT, "..", "auctioneer-kem.json");

/** Auction phases for the live run (seconds). Short, but real on-chain waits. */
const BIDDING_SECONDS = 150;
const REVEAL_SECONDS = 150;
/** Funding per bidder (uqor). Covers registration + window + bid + reveal. */
const BIDDER_FUND_UQOR = 800_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StoredBidder {
  label: string;
  mnemonic: string;
  evm: Address;
  cosmos: string;
}

function loadOrCreateBidders(): StoredBidder[] {
  if (fs.existsSync(BIDDERS_PATH)) {
    const stored = JSON.parse(fs.readFileSync(BIDDERS_PATH, "utf8")) as StoredBidder[];
    console.log(`loaded ${stored.length} bidders from ${BIDDERS_PATH}`);
    return stored;
  }
  const bidders: StoredBidder[] = [];
  for (const label of ["bidder-1", "bidder-2"]) {
    const mnemonic = generateMnemonic(englishWordlist);
    const acc = mnemonicToAccount(mnemonic);
    bidders.push({ label, mnemonic, evm: acc.address, cosmos: "" });
  }
  // Cosmos addresses come from the SDK derivation (same mnemonic).
  fs.writeFileSync(BIDDERS_PATH, JSON.stringify(bidders, null, 2) + "\n", { mode: 0o600 });
  console.log(`wrote ${BIDDERS_PATH} (mode 600)`);
  return bidders;
}

async function main(): Promise<void> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set QORE_MNEMONIC in .env");
  if (!fs.existsSync(path.join(ROOT, "deployments", "testnet.json"))) {
    throw new Error("deployments/testnet.json not found — deploy first (npm run deploy).");
  }
  if (!fs.existsSync(KEM_PATH)) {
    throw new Error("auctioneer-kem.json not found — run `npm run register-kem -- generate` first.");
  }
  const deployment = JSON.parse(
    fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"),
  ) as { contract: Address };
  const contract = deployment.contract;
  const kemStored = JSON.parse(fs.readFileSync(KEM_PATH, "utf8")) as {
    publicKey: Hex;
    secretKey: Hex;
  };
  const kemPublicKey = Buffer.from(kemStored.publicKey.slice(2), "hex");
  const kemSecretKey = Buffer.from(kemStored.secretKey.slice(2), "hex");

  const deployer = await deriveAccount(mnemonic);
  console.log(`deployer/auctioneer: ${deployer.evm} (${deployer.cosmos})`);
  console.log(`contract: ${contract}`);
  console.log(`chain: ${CHAIN_ID} (EVM ${EVM_RPC})`);

  // 0. The auctioneer's KEM key must be registered on-chain: the auction
  //    binds to it by hash, and bidders fetch it from the registry.
  const registered = await fetchKemKey({ rest: REST, address: deployer.cosmos });
  if (!registered.found || !registered.key) {
    throw new Error("No KEM key registered for the deployer — run `npm run register-kem -- register` first.");
  }
  if (kemPublicKeyHash(registered.key.publicKey) !== kemPublicKeyHash(kemPublicKey)) {
    throw new Error("The registered KEM key differs from the local auctioneer keypair.");
  }
  console.log("KEM key: registered on-chain and matches the local keypair.");

  const publicClient = createPublicClient({ chain: testnet, transport: http(EVM_RPC) });
  const deployerEvm = mnemonicToAccount(mnemonic);
  const deployerWallet = createWalletClient({
    account: deployerEvm,
    chain: testnet,
    transport: http(EVM_RPC),
  });

  // 1. Bidders: fund, register PQC key, open window.
  const bidders = loadOrCreateBidders();
  const bidderWallets = [];
  const evidence: Record<string, unknown> = {
    contract,
    auctioneer: deployer.evm,
    kemKeyHash: kemPublicKeyHash(kemPublicKey),
    bids: [],
  };
  for (const b of bidders) {
    const acc = await deriveAccount(b.mnemonic);
    b.cosmos = acc.cosmos;
    console.log(`\n--- ${b.label}: ${acc.evm} (${acc.cosmos}) ---`);
    const balance = await nativeBalance(acc.cosmos);
    console.log(`balance: ${balance} uqor`);
    if (balance < BIDDER_FUND_UQOR) {
      const fundTx = await fundNative(deployer, acc.cosmos, BIDDER_FUND_UQOR, "sealedbid e2e bidder funding");
      console.log(`funded ${BIDDER_FUND_UQOR} uqor: ${fundTx}`);
      await sleep(5000);
    }
    const regTx = await registerPqcKey(acc);
    console.log(regTx ? `PQC key registered: ${regTx}` : "PQC key already registered");
    const winTx = await openWindow(acc, 1200n, 5n);
    console.log(`window opened: ${winTx}`);
    bidderWallets.push({
      ...b,
      wallet: createWalletClient({
        account: mnemonicToAccount(b.mnemonic),
        chain: testnet,
        transport: http(EVM_RPC),
      }),
    });
    await sleep(3000);
  }
  fs.writeFileSync(BIDDERS_PATH, JSON.stringify(bidders, null, 2) + "\n", { mode: 0o600 });
  await sleep(10000); // let the windows settle before the first EVM tx

  // 2. Create the auction.
  console.log("\n--- create auction ---");
  const item = "SealedBid live demo lot — testnet auction #1";
  const createHash = await deployerWallet.writeContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "createAuction",
    args: [item, toHex(kemPublicKey), BigInt(BIDDING_SECONDS), BigInt(REVEAL_SECONDS), 0n],
    chain: testnet,
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  console.log(`create tx: ${createHash} (status ${createReceipt.status})`);
  const auctionCount = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "auctionCount",
  })) as bigint;
  const auctionId = auctionCount - 1n;
  console.log(`auction id: ${auctionId}`);
  // viem returns struct getters as positional tuples:
  // [auctioneer, item, kemKeyHash, biddingDeadline, revealDeadline, minBid,
  //  highestBid, highestBidder, finalized, bidders]
  const auction = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "auctions",
    args: [auctionId],
  })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean, Address[]];
  if (auction[2] !== kemPublicKeyHash(kemPublicKey)) {
    throw new Error("Auction KEM hash does not match the registered key");
  }
  console.log(`bidding until block-time ${auction[3]}, reveal until ${auction[4]}`);
  evidence.createTx = createHash;
  evidence.createTxCosmos = (await cosmosHashForEvmTx(publicClient, createHash)).cosmosHash;
  evidence.auctionId = auctionId.toString();

  // 3. Sealed bids (distinct amounts so the winner is unambiguous).
  const amounts = [1_000_000n, 2_500_000n];
  const bidSecrets: Array<{ bidder: Address; amount: bigint; salt: Hex }> = [];
  for (let i = 0; i < bidderWallets.length; i++) {
    const bw = bidderWallets[i]!;
    const amount = amounts[i]!;
    console.log(`\n--- ${bw.label} seals a bid of ${amount} uqor ---`);
    // The bidder fetches the auctioneer's key from the on-chain registry
    // and verifies it against the auction's recorded hash before sealing.
    const fetched = await fetchKemKey({ rest: REST, address: deployer.cosmos });
    if (!fetched.found || !fetched.key) throw new Error("Registry key vanished mid-run");
    if (kemPublicKeyHash(fetched.key.publicKey) !== auction[2]) {
      throw new Error("Registry key does not match the auction hash — refusing to seal");
    }
    const salt = randomSalt();
    const sealed = sealBid(fetched.key.publicKey, { amount: amount.toString(), salt });
    const commitment = computeCommitment(amount, salt, bw.evm);
    const bidHash = await bw.wallet.writeContract({
      address: contract,
      abi: sealedBidAbi,
      functionName: "submitBid",
      args: [auctionId, toHex(sealed.kemCiphertext), toHex(sealed.sealedBid), commitment],
      chain: testnet,
    });
    const bidReceipt = await publicClient.waitForTransactionReceipt({ hash: bidHash });
    console.log(`bid tx: ${bidHash} (status ${bidReceipt.status})`);
    bidSecrets.push({ bidder: bw.evm, amount, salt });
    (evidence.bids as Array<Record<string, unknown>>).push({
      bidder: bw.evm,
      amountUqor: amount.toString(),
      bidTx: bidHash,
      bidTxCosmos: (await cosmosHashForEvmTx(publicClient, bidHash)).cosmosHash,
    });
  }
  const bidCount = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "bidCount",
    args: [auctionId],
  })) as bigint;
  console.log(`\non-chain bid count: ${bidCount}`);
  if (bidCount !== 2n) throw new Error(`Expected 2 sealed bids on-chain, found ${bidCount}`);

  // 4. Wait for the bidding phase to close, then reveal.
  const waitBidding = Number(auction[3]) * 1000 - Date.now() + 8000;
  console.log(`\nwaiting ${Math.ceil(waitBidding / 1000)}s for the bidding deadline…`);
  await sleep(Math.max(waitBidding, 1000));
  for (let i = 0; i < bidderWallets.length; i++) {
    const bw = bidderWallets[i]!;
    const secret = bidSecrets[i]!;
    console.log(`--- ${bw.label} reveals ${secret.amount} uqor ---`);
    const revealHash = await bw.wallet.writeContract({
      address: contract,
      abi: sealedBidAbi,
      functionName: "revealBid",
      args: [auctionId, secret.amount, secret.salt],
      chain: testnet,
    });
    const revealReceipt = await publicClient.waitForTransactionReceipt({ hash: revealHash });
    console.log(`reveal tx: ${revealHash} (status ${revealReceipt.status})`);
    ((evidence.bids as Array<Record<string, unknown>>)[i] as Record<string, unknown>).revealTx = revealHash;
    ((evidence.bids as Array<Record<string, unknown>>)[i] as Record<string, unknown>).revealTxCosmos = (
      await cosmosHashForEvmTx(publicClient, revealHash)
    ).cosmosHash;
  }
  const afterReveal = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "auctions",
    args: [auctionId],
  })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean, Address[]];
  console.log(`highest revealed: ${afterReveal[6]} uqor by ${afterReveal[7]}`);
  if (afterReveal[6] !== 2_500_000n) throw new Error("Highest bid mismatch after reveal");

  // 5. Wait for the reveal deadline, then finalise.
  const waitReveal = Number(auction[4]) * 1000 - Date.now() + 8000;
  console.log(`\nwaiting ${Math.ceil(waitReveal / 1000)}s for the reveal deadline…`);
  await sleep(Math.max(waitReveal, 1000));
  const finHash = await deployerWallet.writeContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "finalize",
    args: [auctionId],
    chain: testnet,
  });
  const finReceipt = await publicClient.waitForTransactionReceipt({ hash: finHash });
  console.log(`finalize tx: ${finHash} (status ${finReceipt.status})`);
  evidence.finalizeTx = finHash;
  evidence.finalizeTxCosmos = (await cosmosHashForEvmTx(publicClient, finHash)).cosmosHash;

  // 6. Verify the outcome on-chain AND by decrypting the sealed bids.
  const final = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "auctions",
    args: [auctionId],
  })) as unknown as [Address, string, Hex, bigint, bigint, bigint, bigint, Address, boolean, Address[]];
  const phase = (await publicClient.readContract({
    address: contract,
    abi: sealedBidAbi,
    functionName: "phaseOf",
    args: [auctionId],
  })) as number;
  console.log(`\nfinal: winner ${final[7]}, ${final[6]} uqor, finalized=${final[8]}, phase=${phase}`);
  if (!final[8] || phase !== 2) throw new Error("Auction did not finalise");
  if (final[7].toLowerCase() !== bidders[1]!.evm.toLowerCase()) {
    throw new Error("Winner mismatch: expected bidder-2");
  }
  for (const secret of bidSecrets) {
    // bids tuple: [kemCiphertext, sealedBid, commitment, revealedAmount, revealed]
    const stored = (await publicClient.readContract({
      address: contract,
      abi: sealedBidAbi,
      functionName: "bids",
      args: [auctionId, secret.bidder],
    })) as unknown as [Hex, Hex, Hex, bigint, boolean];
    const opened = unsealBid(
      kemSecretKey,
      Buffer.from(stored[0].slice(2), "hex"),
      Buffer.from(stored[1].slice(2), "hex"),
    );
    console.log(
      `decrypted ${secret.bidder.slice(0, 10)}…: amount=${opened.amount} (on-chain reveal: ${stored[3]}, revealed=${stored[4]})`,
    );
    if (BigInt(opened.amount) !== secret.amount || stored[3] !== secret.amount || !stored[4]) {
      throw new Error("Decrypted amount does not match the on-chain reveal");
    }
  }

  evidence.winner = final[7];
  evidence.winningBidUqor = final[6].toString();
  evidence.completedAt = new Date().toISOString();
  const outDir = path.join(ROOT, "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "e2e.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log("\nWrote deployments/e2e.json");
  console.log("E2E auction complete and verified.");
}

main().catch((err: unknown) => {
  console.error("\nE2E run failed.");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
