import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  QORECHAIN_REST_ENDPOINTS,
  evmWindowStatus,
  qorechainTestnet,
} from "@qorechain/evm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { hexToBytes, parseEventLogs, toHex, type Address, type Hex } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { sealedBidAbi } from "../contracts/SealedBid.artifact.js";
import { CONTRACT_DEPLOYED, DEPLOY_BLOCK, EXPLORER_URL, SEALEDBID_ADDRESS, TESTNET_CHAIN_ID } from "./config.js";
import {
  computeCommitment,
  generateKemKeypair,
  kemPublicKeyHash,
  randomSalt,
  sealBid,
  unsealBid,
  type BidPayload,
} from "./lib/kem.js";

/**
 * The REST API of each chain, through the dev server's proxy (vite.config.ts):
 * the public REST endpoints send no CORS headers. Same chains as
 * QORECHAIN_REST_ENDPOINTS.
 */
const REST_PROXY: Record<number, string | undefined> = Object.fromEntries(
  Object.keys(QORECHAIN_REST_ENDPOINTS).map((id) => [
    Number(id),
    Number(id) === qorechainTestnet.id ? "/lcd-testnet" : "/lcd-mainnet",
  ]),
);

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatCountdown(deadlineMs: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Live clock for countdowns (1s tick). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The account's EVM authorisation window, read over the native-lane REST API. */
function WindowStatus({ address, chainId }: { address: `0x${string}`; chainId: number }) {
  const rest = REST_PROXY[chainId];
  const { data, error, isLoading } = useQuery({
    queryKey: ["evm-window", chainId, address],
    queryFn: () => evmWindowStatus({ rest: rest!, address }),
    enabled: rest !== undefined,
    refetchInterval: 10_000,
  });
  if (!rest) return <p>Unknown network.</p>;
  if (isLoading) return <p>Reading the EVM window...</p>;
  // The window status comes from the native-lane REST API, which sends no
  // CORS headers — it is only readable when the app runs behind the /lcd
  // proxy (local dev/preview). On a plain static host this read fails, but
  // transactions still work when the wallet already has a live window open.
  if (error)
    return (
      <p>
        Could not read the EVM window status from here. If you already opened a
        window from QoreX, you can still transact; otherwise open one from QoreX first.
      </p>
    );
  if (!data?.found) {
    return (
      <p>
        EVM window: none. Transactions are refused until one is open — open an EVM window from
        QoreX, then retry.
      </p>
    );
  }
  return (
    <p>
      EVM window: {data.live ? "live" : "not usable"} ({data.remainingBlocks.toString()} blocks,{" "}
      {data.remainingTxs.toString()} transactions, {data.remainingValue.toString()} uqor left)
      {!data.live ? " Open a new EVM window from QoreX, then retry." : ""}
    </p>
  );
}

// ---------------------------------------------------------------------------
// On-chain shapes (viem returns struct getters as positional tuples)
// ---------------------------------------------------------------------------

/**
 * auctions tuple: [auctioneer, item, kemKeyHash, biddingDeadline, revealDeadline,
 * minBid, highestBid, highestBidder, finalized].
 *
 * NOTE: Solidity's auto-generated getter for a struct containing a
 * dynamically-sized array does NOT return that array — `bidders` is absent
 * from the getter's outputs, so it must be read via the explicit
 * `getBidders(auctionId)` view function instead (see AuctionCard).
 */
type AuctionTuple = readonly [
  Address,
  string,
  Hex,
  bigint,
  bigint,
  bigint,
  bigint,
  Address,
  boolean,
];

interface AuctionView {
  id: bigint;
  auctioneer: Address;
  item: string;
  kemKeyHash: Hex;
  biddingDeadline: bigint;
  revealDeadline: bigint;
  minBid: bigint;
  highestBid: bigint;
  highestBidder: Address;
  finalized: boolean;
}

function parseAuction(id: bigint, t: AuctionTuple): AuctionView {
  return {
    id,
    auctioneer: t[0],
    item: t[1],
    kemKeyHash: t[2],
    biddingDeadline: t[3],
    revealDeadline: t[4],
    minBid: t[5],
    highestBid: t[6],
    highestBidder: t[7],
    finalized: t[8],
  };
}

/** bids tuple: [kemCiphertext, sealedBid, commitment, revealedAmount, revealed] */
type BidTuple = readonly [Hex, Hex, Hex, bigint, boolean];

interface BidView {
  kemCiphertext: Hex;
  sealedBid: Hex;
  commitment: Hex;
  revealedAmount: bigint;
  revealed: boolean;
}

function parseBid(t: BidTuple): BidView {
  return {
    kemCiphertext: t[0],
    sealedBid: t[1],
    commitment: t[2],
    revealedAmount: t[3],
    revealed: t[4],
  };
}

const PHASE_NAMES = ["Bidding", "Revealing", "Finalized"] as const;

/**
 * Explicit fee caps and gas limits for every transaction the UI sends.
 * The chain's fee market is volatile — viem's uncapped estimate spiked to
 * ~2000–6000 gwei during testing, and a window admits a transaction only
 * when `gasLimit x maxFeePerGas` fits its remaining value, so uncapped
 * transactions were rejected with "gas required exceeds allowance". The
 * base fee sits at ~100 gwei, so a 150 gwei cap leaves headroom while
 * keeping the max fee of a sealed bid (1.5M gas x 150 gwei = 0.225 QOR)
 * affordable. Gas limits are ceilings, not charges: a sealed bid actually
 * uses ~1.37M gas (storing the 1568-byte ML-KEM ciphertext dominates the
 * cost).
 */
const TX_FEES = {
  maxFeePerGas: 150_000_000_000n, // 150 gwei
  maxPriorityFeePerGas: 12_500_000_000n, // 12.5 gwei
} as const;
const TX_GAS = {
  createAuction: 700_000n,
  submitBid: 1_500_000n,
  revealBid: 250_000n,
  finalize: 200_000n,
} as const;

// ---------------------------------------------------------------------------
// Browser key storage (testnet demo only — see the honest-notes footer)
// ---------------------------------------------------------------------------

const KEM_SECRET_KEY = "sealedbid-kem-secret";
const bidSaltKey = (auctionId: bigint, bidder: string) =>
  `sealedbid-bid-${auctionId}-${bidder.toLowerCase()}`;

function loadKemSecret(): Hex | null {
  try {
    const raw = localStorage.getItem(KEM_SECRET_KEY);
    return raw && raw.startsWith("0x") ? (raw as Hex) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auction card
// ---------------------------------------------------------------------------

function BidRow({
  auction,
  bidder,
  isAuctioneerKey,
}: {
  auction: AuctionView;
  bidder: Address;
  isAuctioneerKey: Uint8Array | null;
}) {
  const { data } = useReadContract({
    address: SEALEDBID_ADDRESS as Address,
    abi: sealedBidAbi,
    functionName: "bids",
    args: [auction.id, bidder],
    query: { refetchInterval: 5000 },
  });
  const [decrypted, setDecrypted] = useState<BidPayload | null>(null);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  if (!data) return null;
  const bid = parseBid(data as unknown as BidTuple);
  const decrypt = () => {
    if (!isAuctioneerKey) return;
    try {
      setDecrypted(
        unsealBid(isAuctioneerKey, hexToBytes(bid.kemCiphertext), hexToBytes(bid.sealedBid)),
      );
      setDecryptError(null);
    } catch (e) {
      setDecryptError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <li>
      {shorten(bidder)} —{" "}
      {bid.revealed ? (
        <>
          revealed <strong>{bid.revealedAmount.toString()} uqor</strong>
        </>
      ) : (
        <>sealed (ciphertext {bid.kemCiphertext.slice(0, 18)}…)</>
      )}
      {isAuctioneerKey && !bid.revealed && (
        <>
          {" "}
          <button type="button" onClick={decrypt}>
            Decrypt (local)
          </button>
          {decrypted && (
            <span>
              {" "}
              → decrypted locally: <strong>{decrypted.amount} uqor</strong> (not an on-chain
              reveal)
            </span>
          )}
          {decryptError && <span> → decrypt failed: {decryptError}</span>}
        </>
      )}
    </li>
  );
}

function AuctionCard({
  auctionId,
  account,
  onChanged,
}: {
  auctionId: bigint;
  account: Address | undefined;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const publicClient = usePublicClient();
  const now = useNow();
  const [bidAmount, setBidAmount] = useState("");
  const [bidStatus, setBidStatus] = useState<string | null>(null);
  const [revealSalt, setRevealSalt] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: rawAuction } = useReadContract({
    address: SEALEDBID_ADDRESS as Address,
    abi: sealedBidAbi,
    functionName: "auctions",
    args: [auctionId],
    query: { refetchInterval: 5000 },
  });
  const { data: phaseData } = useReadContract({
    address: SEALEDBID_ADDRESS as Address,
    abi: sealedBidAbi,
    functionName: "phaseOf",
    args: [auctionId],
    query: { refetchInterval: 5000 },
  });
  const { data: hasBidData } = useReadContract({
    address: SEALEDBID_ADDRESS as Address,
    abi: sealedBidAbi,
    functionName: "hasBid",
    args: [auctionId, account ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: account !== undefined, refetchInterval: 5000 },
  });
  // The `auctions` getter omits the bidders array (see AuctionTuple note),
  // so read it through the explicit view function.
  const { data: biddersData } = useReadContract({
    address: SEALEDBID_ADDRESS as Address,
    abi: sealedBidAbi,
    functionName: "getBidders",
    args: [auctionId],
    query: { refetchInterval: 5000 },
  });

  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });
  useEffect(() => {
    if (!receipt.data) return;
    setBidStatus(null);
    onChanged();
    void queryClient.invalidateQueries();
  }, [receipt.data, onChanged, queryClient]);

  // The auctioneer's KEM public key, from the AuctionCreated event logs
  // (the chain's REST registry has no CORS headers, so the browser reads
  // the key from the EVM event instead and verifies it against the hash).
  const { data: kemPublicKey } = useQuery({
    queryKey: ["kem-key", auctionId.toString()],
    queryFn: async (): Promise<Uint8Array | null> => {
      if (!publicClient) return null;
      const logs = await publicClient.getLogs({
        address: SEALEDBID_ADDRESS as Address,
        event: {
          type: "event",
          name: "AuctionCreated",
          inputs: [
            { name: "auctionId", type: "uint256", indexed: true },
            { name: "auctioneer", type: "address", indexed: true },
            { name: "item", type: "string", indexed: false },
            { name: "kemKeyHash", type: "bytes32", indexed: false },
            { name: "kemPublicKey", type: "bytes", indexed: false },
            { name: "biddingDeadline", type: "uint256", indexed: false },
            { name: "revealDeadline", type: "uint256", indexed: false },
            { name: "minBid", type: "uint256", indexed: false },
          ],
          anonymous: false,
        },
        args: { auctionId },
        fromBlock: DEPLOY_BLOCK,
        toBlock: "latest",
      });
      if (logs.length === 0) return null;
      const parsed = parseEventLogs({ abi: sealedBidAbi, logs });
      const ev = parsed.find((e) => e.eventName === "AuctionCreated");
      if (!ev) return null;
      const args = ev.args as unknown as { kemPublicKey: Hex };
      return hexToBytes(args.kemPublicKey);
    },
    enabled: publicClient !== undefined,
    staleTime: Infinity,
  });

  const auctioneerSecret = useMemo(() => {
    const hex = loadKemSecret();
    return hex ? hexToBytes(hex) : null;
  }, [account]);
  const isAuctioneer = account !== undefined && rawAuction !== undefined
    ? (rawAuction as unknown as AuctionTuple)[0].toLowerCase() === account.toLowerCase()
    : false;

  if (!rawAuction || phaseData === undefined) return null;
  const auction = parseAuction(auctionId, rawAuction as unknown as AuctionTuple);
  const bidders: readonly Address[] = biddersData ?? [];
  const phase = Number(phaseData) as 0 | 1 | 2;
  const hasBid = hasBidData === true;
  const biddingEndsMs = Number(auction.biddingDeadline) * 1000;
  const revealEndsMs = Number(auction.revealDeadline) * 1000;
  const pastRevealDeadline = now >= revealEndsMs;

  const submitBid = async () => {
    setActionError(null);
    if (!account) return;
    if (!kemPublicKey) {
      setActionError("Could not read the auctioneer's KEM public key from the chain yet.");
      return;
    }
    if (kemPublicKeyHash(kemPublicKey) !== auction.kemKeyHash) {
      setActionError("The KEM public key does not match the auction's recorded hash — refusing to seal.");
      return;
    }
    let amount: bigint;
    try {
      amount = BigInt(bidAmount);
      if (amount <= 0n) throw new Error("amount must be positive");
    } catch {
      setActionError("Enter a bid amount in uqor (a positive whole number).");
      return;
    }
    setBidStatus("Encrypting your bid client-side (ML-KEM-1024 + AES-256-GCM)…");
    const salt = randomSalt();
    const sealed = sealBid(kemPublicKey, { amount: amount.toString(), salt });
    const commitment = computeCommitment(amount, salt, account);
    try {
      localStorage.setItem(
        bidSaltKey(auctionId, account),
        JSON.stringify({ amount: amount.toString(), salt }),
      );
    } catch {
      // Storage failing must not block the bid — but without the salt the
      // bid cannot be revealed later, so warn loudly.
      setActionError(
        "Warning: could not store the reveal salt in this browser. Save it yourself — " +
          `salt ${salt}, amount ${amount.toString()} — or this bid can never be revealed.`,
      );
      return;
    }
    setBidStatus("Submitting the sealed bid on-chain…");
    write.writeContract({
      address: SEALEDBID_ADDRESS as Address,
      abi: sealedBidAbi,
      functionName: "submitBid",
      args: [auctionId, toHex(sealed.kemCiphertext), toHex(sealed.sealedBid), commitment],
      gas: TX_GAS.submitBid,
      ...TX_FEES,
    });
  };

  const revealBid = async (saltOverride?: string) => {
    setActionError(null);
    if (!account) return;
    let stored: { amount: string; salt: Hex } | null = null;
    try {
      const raw = localStorage.getItem(bidSaltKey(auctionId, account));
      stored = raw ? (JSON.parse(raw) as { amount: string; salt: Hex }) : null;
    } catch {
      stored = null;
    }
    const salt = (saltOverride ?? revealSalt).trim() || stored?.salt;
    const amountStr = stored?.amount;
    if (!salt || !amountStr) {
      setActionError(
        "No reveal salt found in this browser. Paste the salt from when you placed the bid.",
      );
      return;
    }
    write.writeContract({
      address: SEALEDBID_ADDRESS as Address,
      abi: sealedBidAbi,
      functionName: "revealBid",
      args: [auctionId, BigInt(amountStr), salt as Hex],
      gas: TX_GAS.revealBid,
      ...TX_FEES,
    });
  };

  const finalize = () => {
    setActionError(null);
    write.writeContract({
      address: SEALEDBID_ADDRESS as Address,
      abi: sealedBidAbi,
      functionName: "finalize",
      args: [auctionId],
      gas: TX_GAS.finalize,
      ...TX_FEES,
    });
  };

  return (
    <section style={{ border: "1px solid #444", borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <h3>
        #{auction.id.toString()} — {auction.item}
      </h3>
      <p>
        Auctioneer: {shorten(auction.auctioneer)} · Phase: <strong>{PHASE_NAMES[phase]}</strong>{" "}
        {phase === 0 && <>· bidding closes in {formatCountdown(biddingEndsMs, now)}</>}
        {phase === 1 && !pastRevealDeadline && (
          <>· reveal closes in {formatCountdown(revealEndsMs, now)}</>
        )}
        {phase === 1 && pastRevealDeadline && <>· reveal closed, awaiting finalisation</>}
      </p>
      <p>
        Minimum bid: {auction.minBid.toString()} uqor · Bids: {bidders.length}
        {auction.highestBid > 0n && (
          <>
            {" "}
            · Highest revealed: <strong>{auction.highestBid.toString()} uqor</strong> by{" "}
            {shorten(auction.highestBidder)}
          </>
        )}
        {auction.finalized && (
          <>
            {" "}
            · Winner:{" "}
            <strong>
              {auction.highestBidder === "0x0000000000000000000000000000000000000000"
                ? "none (no bid revealed)"
                : `${shorten(auction.highestBidder)} at ${auction.highestBid.toString()} uqor`}
            </strong>
          </>
        )}
      </p>
      <p>
        KEM key hash: <code>{auction.kemKeyHash.slice(0, 18)}…</code>
        {kemPublicKey
          ? kemPublicKeyHash(kemPublicKey) === auction.kemKeyHash
            ? " (public key verified against the hash)"
            : " (WARNING: public key does NOT match the hash)"
          : " (reading public key…)"}
      </p>
      {bidders.length > 0 && (
        <ul>
          {bidders.map((b) => (
            <BidRow
              key={b}
              auction={auction}
              bidder={b}
              isAuctioneerKey={isAuctioneer ? auctioneerSecret : null}
            />
          ))}
        </ul>
      )}

      {account && phase === 0 && !hasBid && (
        <div>
          <input
            value={bidAmount}
            onChange={(e) => setBidAmount(e.target.value)}
            placeholder="Bid amount in uqor (e.g. 1000000)"
            style={{ width: 280, marginRight: 8 }}
          />
          <button type="button" onClick={submitBid} disabled={write.isPending || receipt.isLoading}>
            Seal &amp; submit bid
          </button>
          <p>
            Your bid is encrypted in this browser with ML-KEM-1024 to the auctioneer&apos;s key.
            Only the ciphertext goes on-chain — nobody except the auctioneer can read the amount
            before you reveal it.
          </p>
        </div>
      )}
      {account && phase === 0 && hasBid && <p>Your sealed bid is on-chain. Wait for the reveal phase.</p>}
      {account && phase === 1 && !pastRevealDeadline && hasBid && (
        <div>
          <input
            value={revealSalt}
            onChange={(e) => setRevealSalt(e.target.value)}
            placeholder="Salt (leave empty to use the one stored in this browser)"
            style={{ width: 420, marginRight: 8 }}
          />
          <button type="button" onClick={() => revealBid()} disabled={write.isPending || receipt.isLoading}>
            Reveal my bid
          </button>
          <p>
            The contract checks your revealed amount against the commitment from your sealed bid —
            a wrong amount or salt is rejected.
          </p>
        </div>
      )}
      {account && phase === 1 && pastRevealDeadline && !auction.finalized && (
        <div>
          <button type="button" onClick={finalize} disabled={write.isPending || receipt.isLoading}>
            Finalise auction
          </button>
        </div>
      )}
      {bidStatus && <p>{bidStatus}</p>}
      {write.data && <p>Transaction submitted: {write.data}</p>}
      {receipt.isLoading && <p>Waiting for confirmation…</p>}
      {receipt.isSuccess && <p>Confirmed.</p>}
      {(write.error || actionError) && (
        <p style={{ color: "#ff8a8a" }}>
          {actionError ?? write.error?.message ?? "Transaction failed."}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Create auction
// ---------------------------------------------------------------------------

function CreateAuction({ account, onCreated }: { account: Address; onCreated: () => void }) {
  const queryClient = useQueryClient();
  const [item, setItem] = useState("");
  const [minBid, setMinBid] = useState("0");
  const [biddingMinutes, setBiddingMinutes] = useState("60");
  const [revealMinutes, setRevealMinutes] = useState("30");
  const [pubKeyHex, setPubKeyHex] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data });
  useEffect(() => {
    if (!receipt.data) return;
    setStatus("Auction created.");
    onCreated();
    void queryClient.invalidateQueries();
  }, [receipt.data, onCreated, queryClient]);

  const generateKey = () => {
    const kp = generateKemKeypair();
    try {
      localStorage.setItem(KEM_SECRET_KEY, toHex(kp.secretKey));
    } catch {
      setError("Could not store the secret key in this browser — key generation aborted.");
      return;
    }
    setPubKeyHex(toHex(kp.publicKey));
    setStatus(
      "Keypair generated in this browser. The secret key is stored in this browser's local " +
        "storage (testnet demo only — never do this with a real key). Publish the public key " +
        "in the x/pqc KEM registry with scripts/register-kem.ts so bidders can find it there too.",
    );
    setError(null);
  };

  const create = () => {
    setError(null);
    setStatus(null);
    if (!item.trim()) {
      setError("Describe the item being auctioned.");
      return;
    }
    let pubkey: Uint8Array;
    try {
      pubkey = hexToBytes(pubKeyHex.trim() as Hex);
    } catch {
      setError("The KEM public key is not valid hex. Generate one or paste a 1568-byte key.");
      return;
    }
    if (pubkey.length !== 1568) {
      setError(`The KEM public key must be 1568 bytes (ML-KEM-1024), got ${pubkey.length}.`);
      return;
    }
    const biddingSecs = Number(biddingMinutes) * 60;
    const revealSecs = Number(revealMinutes) * 60;
    if (!Number.isFinite(biddingSecs) || biddingSecs <= 0 || !Number.isFinite(revealSecs) || revealSecs <= 0) {
      setError("Bidding and reveal durations must be positive numbers of minutes.");
      return;
    }
    let min: bigint;
    try {
      min = BigInt(minBid);
      if (min < 0n) throw new Error("negative");
    } catch {
      setError("Minimum bid must be a whole number of uqor (0 or more).");
      return;
    }
    write.writeContract({
      address: SEALEDBID_ADDRESS as Address,
      abi: sealedBidAbi,
      functionName: "createAuction",
      args: [item.trim(), pubKeyHex.trim() as Hex, BigInt(biddingSecs), BigInt(revealSecs), min],
      gas: TX_GAS.createAuction,
      ...TX_FEES,
    });
  };

  return (
    <section style={{ border: "1px solid #444", borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <h3>Create an auction</h3>
      <p>
        <input
          value={item}
          onChange={(e) => setItem(e.target.value)}
          placeholder="Item description (e.g. Testnet lot #1)"
          style={{ width: 420, marginRight: 8 }}
        />
      </p>
      <p>
        Minimum bid (uqor):{" "}
        <input
          value={minBid}
          onChange={(e) => setMinBid(e.target.value)}
          style={{ width: 140, marginRight: 16 }}
        />
        Bidding (minutes):{" "}
        <input
          value={biddingMinutes}
          onChange={(e) => setBiddingMinutes(e.target.value)}
          style={{ width: 80, marginRight: 16 }}
        />
        Reveal (minutes):{" "}
        <input
          value={revealMinutes}
          onChange={(e) => setRevealMinutes(e.target.value)}
          style={{ width: 80 }}
        />
      </p>
      <p>
        Your ML-KEM-1024 public key (1568 bytes, hex):{" "}
        <button type="button" onClick={generateKey}>
          Generate keypair in this browser
        </button>
      </p>
      <p>
        <input
          value={pubKeyHex}
          onChange={(e) => setPubKeyHex(e.target.value)}
          placeholder="0x… (1568 bytes)"
          style={{ width: "100%" }}
        />
      </p>
      <p>
        <button type="button" onClick={create} disabled={write.isPending || receipt.isLoading}>
          Create auction
        </button>
      </p>
      {status && <p>{status}</p>}
      {write.data && <p>Transaction submitted: {write.data}</p>}
      {receipt.isLoading && <p>Waiting for confirmation…</p>}
      {(write.error || error) && (
        <p style={{ color: "#ff8a8a" }}>{error ?? write.error?.message ?? "Transaction failed."}</p>
      )}
      <p>
        The auction binds to your KEM key by hash. Bidders encrypt to the key published in the
        chain&apos;s x/pqc KEM registry — register it with{" "}
        <code>npm run register-kem -- register</code> (see the README) so the registry and the
        auction agree.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const { address, chainId, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const queryClient = useQueryClient();
  // Refresh on-chain data after a transaction confirms. This used to bump
  // a refreshKey baked into the card keys — which remounted the cards and
  // wiped the "Confirmed." state. Never key a card on anything that changes
  // when a transaction lands.
  const onChanged = useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);

  const { data: auctionCount } = useReadContract({
    address: SEALEDBID_ADDRESS as Address,
    abi: sealedBidAbi,
    functionName: "auctionCount",
    query: { enabled: CONTRACT_DEPLOYED, refetchInterval: 5000 },
  });

  const wrongChain = isConnected && chainId !== TESTNET_CHAIN_ID;
  const auctionIds = useMemo(() => {
    const n = auctionCount === undefined ? 0 : Number(auctionCount);
    return Array.from({ length: n }, (_, i) => BigInt(n - 1 - i)); // newest first
  }, [auctionCount]);

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>SealedBid</h1>
      <p>
        Sealed-bid auctions on the QoreChain testnet. Bids are encrypted in your browser with
        ML-KEM-1024 (FIPS 203) to the auctioneer&apos;s chain-registered public key — only
        ciphertext goes on-chain, so bids stay sealed until the reveal phase.
      </p>
      <div>
        <ConnectButton />
      </div>
      {wrongChain && (
        <p>
          You are on the wrong network.{" "}
          <button type="button" onClick={() => switchChain({ chainId: TESTNET_CHAIN_ID })}>
            Switch to QoreChain testnet
          </button>
        </p>
      )}
      {isConnected && address && chainId !== undefined && (
        <WindowStatus address={address} chainId={chainId} />
      )}
      {!CONTRACT_DEPLOYED && (
        <p>The SealedBid contract has not been deployed yet — auctions will appear here once it is.</p>
      )}
      {CONTRACT_DEPLOYED && (
        <p>
          Contract:{" "}
          <a href={`${EXPLORER_URL}/address/${SEALEDBID_ADDRESS}`} target="_blank" rel="noreferrer">
            {SEALEDBID_ADDRESS}
          </a>{" "}
          (QoreChain testnet, chain id {TESTNET_CHAIN_ID})
        </p>
      )}

      {CONTRACT_DEPLOYED && isConnected && address && !wrongChain && (
        <CreateAuction account={address} onCreated={onChanged} />
      )}
      {CONTRACT_DEPLOYED && !isConnected && (
        <p>Connect a wallet to create auctions, bid, and reveal. You can browse auctions below without one.</p>
      )}

      <h2>Auctions</h2>
      {CONTRACT_DEPLOYED && auctionCount === undefined && <p>Loading auctions…</p>}
      {CONTRACT_DEPLOYED && auctionCount !== undefined && auctionIds.length === 0 && (
        <p>No auctions yet. Create the first one above.</p>
      )}
      {CONTRACT_DEPLOYED &&
        auctionIds.map((id) => (
          // The key MUST stay stable across transactions: the receipt effect
          // calls onChanged(), and if the key changed with it the card would
          // remount the moment a transaction confirmed, wiping the
          // useWriteContract state that renders "Confirmed." (this bit the
          // demo recording on 15 Nov 2026 — the reveal landed on-chain but
          // the confirmation text never survived a frame). Data refreshes
          // via queryClient.invalidateQueries(), not via remounting.
          <AuctionCard
            key={id.toString()}
            auctionId={id}
            account={address}
            onChanged={onChanged}
          />
        ))}

      <footer style={{ marginTop: 32, borderTop: "1px solid #444", paddingTop: 16 }}>
        <h3>Honest notes</h3>
        <ul>
          <li>
            <strong>What runs where.</strong> ML-KEM-1024 encryption and decryption run{" "}
            <em>client-side</em> (in this browser, via @noble/post-quantum) — the EVM cannot do
            ML-KEM natively. The contract stores sealed bids and enforces the rules: deadlines,
            one bid per bidder, and reveal verification against each bidder&apos;s commitment.
          </li>
          <li>
            <strong>Who can read a sealed bid.</strong> Only the auctioneer, who holds the ML-KEM
            secret key. Bids are sealed from other bidders and the public — not from the
            auctioneer. The auctioneer cannot misreport an amount, because the winner is decided
            only from on-chain reveals, each checked against the bidder&apos;s own commitment.
          </li>
          <li>
            <strong>Keys in this browser.</strong> A keypair generated here keeps its secret key in
            this browser&apos;s local storage, and each bid&apos;s reveal salt is stored the same
            way. That is fine for a testnet demo and unacceptable for real stakes — clear your
            storage or lose the salt, and a bid can never be revealed.
          </li>
          <li>
            <strong>No funds move.</strong> Bid amounts are recorded in uqor units and the winner
            is determined on-chain; the contract holds no funds and settlement happens off-chain.
          </li>
          <li>
            <strong>Key binding.</strong> Each auction records the keccak256 hash of the
            auctioneer&apos;s ML-KEM-1024 public key as published in the chain&apos;s x/pqc KEM
            registry (a hybrid-signed, ML-DSA-bound registration). Bidders verify the key against
            that hash before encrypting.
          </li>
        </ul>
      </footer>
    </main>
  );
}
