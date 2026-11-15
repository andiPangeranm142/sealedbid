import { isAddress } from "viem";

/** EVM chain id of the QoreChain testnet (`qorechain-diana`). */
export const TESTNET_CHAIN_ID = 9800;

/** QoreChain block explorer (covers the testnet). */
export const EXPLORER_URL = "https://explore.qore.network";

/**
 * The deployed SealedBid contract address, read from the build-time
 * environment. Empty string means the contract has not been deployed yet —
 * the UI must not show auction actions in that case.
 *
 * A malformed value is treated the same as unset: never trust a bad address.
 */
const raw = (import.meta.env.VITE_SEALEDBID_ADDRESS ?? "").trim();

export const SEALEDBID_ADDRESS: `0x${string}` | "" = isAddress(raw)
  ? (raw as `0x${string}`)
  : "";

export const CONTRACT_DEPLOYED = SEALEDBID_ADDRESS !== "";

/**
 * Block the SealedBid contract was deployed in (deploy tx
 * 0x192e900b95562d4cab25bda35a83feba8cdad241495090ed2e6ec7821486ba7e).
 * The contract cannot have emitted events before this block, so event-log
 * scans start here instead of block 0 (the chain has 10M+ blocks and a
 * full scan takes far too long in the browser).
 */
export const DEPLOY_BLOCK = 10151543n;
