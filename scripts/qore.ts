/**
 * qore.ts - shared QoreChain Diana testnet helpers for the SealedBid scripts.
 *
 * Covers the native-lane operations every account needs before it can send
 * an EVM transaction: ML-DSA-87 key registration (the account's very first
 * transaction, signed classically), EVM authorisation windows (hybrid
 * signed), native QOR funding, and ML-KEM-1024 key publication in the
 * x/pqc KEM registry (hybrid signed, needs the ML-DSA key first).
 *
 * Testnet only. Nothing in here runs on mainnet.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchPqcStatus,
  isRegisteredPqcKey,
  openEvmWindowMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { msg } from "@qorechain/sdk";
import { KEM_ALGORITHM_ML_KEM_1024 } from "@qorechain/sdk";
import { evmWindowCost } from "@qorechain/evm";
import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";

export const REST = "https://api-testnet.qore.host";
export const RPC = "https://rpc-testnet.qore.host";
export const CHAIN_ID = "qorechain-diana";
export const EVM_RPC = "https://evm-testnet.qore.host";

/** A native-lane fee: hybrid transactions are large, so the gas limit is generous (~0.1 QOR). */
export const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

export async function deriveAccount(mnemonic: string): Promise<UnifiedAccount> {
  return deriveUnifiedAccount(mnemonic, 0);
}

/** account_number and sequence over REST; retries briefly on transient errors. */
export async function accountSequence(
  address: string,
): Promise<{ accountNumber: bigint; sequence: bigint }> {
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
    if (res.ok) {
      const body = (await res.json()) as { account?: Record<string, unknown> };
      const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
      return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
    }
    lastStatus = res.status;
    lastBody = (await res.text()).slice(0, 200);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`account query failed for ${address}: HTTP ${lastStatus} ${lastBody}`);
}

/** Native QOR balance (uqor) of a cosmos address; 0n when the account does not exist yet. */
export async function nativeBalance(address: string): Promise<bigint> {
  const res = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${address}`);
  if (!res.ok) throw new Error(`balance query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { balances?: Array<{ denom: string; amount: string }> };
  const row = body.balances?.find((b) => b.denom === "uqor");
  return BigInt(row?.amount ?? "0");
}

type SignMode = "hybrid" | "classical";
type Messages = Parameters<EthNativeSigner["sign"]>[0]["messages"];

/** Sign and broadcast native-lane messages. Returns the tx hash and deliver code. */
export async function broadcastNative(
  acc: UnifiedAccount,
  mode: SignMode,
  messages: Messages,
  memo = "",
): Promise<{ hash: string; code: number }> {
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(RPC);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: CHAIN_ID,
      accountNumber,
      sequence,
      fee: FEE,
      memo,
      messages,
    });
    return { hash: res.transactionHash, code: res.code };
  } finally {
    transport.disconnect();
  }
}

/** Whether the account already has the ML-DSA-87 key derived from its mnemonic. */
export async function hasPqcKey(acc: UnifiedAccount): Promise<boolean> {
  const pqc = await fetchPqcStatus({ rest: REST, address: acc.cosmos });
  return pqc.registered ? isRegisteredPqcKey(pqc, acc.pqc.publicKey) === true : false;
}

/**
 * Register the account's ML-DSA-87 key. MUST be the account's very first
 * transaction (the chain only accepts it signed classically, and only
 * before any other transaction from the account). No-op when already
 * registered.
 */
export async function registerPqcKey(acc: UnifiedAccount): Promise<string | null> {
  if (await hasPqcKey(acc)) return null;
  const proofOfPossession = signProofOfPossession({
    chainId: CHAIN_ID,
    account: acc.cosmos,
    keypair: acc.pqc,
  });
  const msgRegister = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
  const { hash, code } = await broadcastNative(acc, "classical", [msgRegister]);
  if (code !== 0) throw new Error(`PQC key registration rejected (code ${code})`);
  return hash;
}

/**
 * Open an EVM authorisation window for the account. Each admitted EVM
 * transaction may consume value + gas limit x fee cap, so the window is
 * sized for `maxTxs` transactions of up to 3,000,000 gas at a 250 gwei fee
 * cap unless maxUqor is given explicitly.
 */
export async function openWindow(
  acc: UnifiedAccount,
  blocks = 1200n,
  maxTxs = 10n,
  maxUqor?: bigint,
): Promise<string> {
  const perTx = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 250_000_000_000n });
  const maxValue = maxUqor ?? perTx * maxTxs;
  const m = openEvmWindowMsg({ sender: acc.cosmos, blocks, maxTxs, maxValue });
  const { hash, code } = await broadcastNative(acc, "hybrid", [m]);
  if (code !== 0) throw new Error(`openEvmWindow rejected (code ${code})`);
  return hash;
}

/** Send native QOR (uqor) from one account to a cosmos address. */
export async function fundNative(
  from: UnifiedAccount,
  to: string,
  amountUqor: bigint,
  memo = "sealedbid funding",
): Promise<string> {
  const { accountNumber, sequence } = await accountSequence(from.cosmos);
  const signer = new EthNativeSigner(from, { signMode: "hybrid", rest: REST });
  const transport = await StargateClient.connect(RPC);
  try {
    const res = await signer.bankSend(transport, to, [{ denom: "uqor", amount: amountUqor.toString() }], {
      chainId: CHAIN_ID,
      accountNumber,
      sequence,
      fee: FEE,
      memo,
    });
    if (res.code !== 0) throw new Error(`bankSend rejected (code ${res.code})`);
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

/**
 * Publish the account's ML-KEM-1024 public key in the x/pqc KEM registry
 * (MsgRegisterKEMKey, hybrid signed). The sender must already hold a
 * registered ML-DSA-87 key — that is the ML-DSA binding: the registry
 * entry is authenticated by the account's hybrid signature, so the KEM key
 * is bound to the same account (and therefore the same ML-DSA key) that
 * publishes it. Re-publishing replaces the key.
 */
export async function registerKemKey(acc: UnifiedAccount, publicKey: Uint8Array): Promise<string> {
  const m = msg.pqc.registerKemKey({
    sender: acc.cosmos,
    algorithmId: KEM_ALGORITHM_ML_KEM_1024,
    publicKey,
  });
  const { hash, code } = await broadcastNative(acc, "hybrid", [m]);
  if (code !== 0) throw new Error(`MsgRegisterKEMKey rejected (code ${code})`);
  return hash;
}

/** Minimal protobuf field reader (for TxRaw -> MsgEthereumTx matching). */
function readVarint(buf: Buffer, off: number): [bigint, number] {
  let v = 0n;
  let s = 0n;
  for (;;) {
    const b = buf[off++] as number;
    v |= BigInt(b & 0x7f) << s;
    if (!(b & 0x80)) break;
    s += 7n;
  }
  return [v, off];
}

function pbFields(buf: Buffer): Array<[number, Buffer]> {
  const out: Array<[number, Buffer]> = [];
  let off = 0;
  while (off < buf.length) {
    const [tag, o1] = readVarint(buf, off);
    off = o1;
    const num = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 2) {
      const [len, o2] = readVarint(buf, off);
      off = o2;
      out.push([num, buf.subarray(off, off + Number(len))]);
      off += Number(len);
    } else if (wt === 0) {
      const [, o2] = readVarint(buf, off);
      off = o2;
    } else if (wt === 5) {
      off += 4;
    } else if (wt === 1) {
      off += 8;
    } else {
      throw new Error(`bad protobuf wire type ${wt}`);
    }
  }
  return out;
}

type ReceiptReader = {
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ blockNumber: bigint }>;
};

/**
 * The Cosmos transaction hash (uppercase hex, no 0x) wrapping an EVM
 * transaction hash. The explorer's /tx/ route only resolves Cosmos
 * hashes, so EVM hashes must be translated this way before linking:
 * take the receipt's block, then find the MsgEthereumTx whose embedded
 * raw transaction hashes (keccak256) to the EVM hash.
 */
export async function cosmosHashForEvmTx(
  publicClient: ReceiptReader,
  evmHash: Hex,
): Promise<{ cosmosHash: string; block: number }> {
  const receipt = await publicClient.getTransactionReceipt({ hash: evmHash });
  const height = Number(receipt.blockNumber);
  const res = await fetch(`${REST}/cosmos/base/tendermint/v1beta1/blocks/${height}`);
  if (!res.ok) throw new Error(`block ${height} query failed: HTTP ${res.status}`);
  const block = (await res.json()) as { block: { data: { txs: string[] } } };
  for (const txb64 of block.block.data.txs) {
    const raw = Buffer.from(txb64, "base64");
    const body = pbFields(raw).find(([n]) => n === 1)?.[1];
    if (!body) continue;
    for (const [, anyMsg] of pbFields(body).filter(([n]) => n === 1)) {
      const f = pbFields(anyMsg);
      const typeUrl = f.find(([n]) => n === 1)?.[1]?.toString() ?? "";
      if (!typeUrl.endsWith("MsgEthereumTx")) continue;
      const value = f.find(([n]) => n === 2)?.[1];
      if (!value) continue;
      const data = pbFields(value).find(([n]) => n === 6)?.[1];
      if (data && keccak256(data).toLowerCase() === evmHash.toLowerCase()) {
        return {
          cosmosHash: createHash("sha256").update(raw).digest("hex").toUpperCase(),
          block: height,
        };
      }
    }
  }
  throw new Error(`no Cosmos tx found for EVM hash ${evmHash} in block ${height}`);
}
