/**
 * deploy.ts - deploy the SealedBid contract to the QoreChain EVM Engine
 * (testnet qorechain-diana, chain id 9800).
 *
 * Uses @qorechain/evm:
 *   - createEvmClient({ endpoints })  → a viem-backed client (chain id auto-detected)
 *   - deployContract(walletClient, …) → deploy and get the tx hash
 *
 * Prerequisites (see README):
 *   - QORE_EVM_RPC_URL pointing at the testnet EVM JSON-RPC endpoint.
 *   - QORE_EVM_PRIVATE_KEY for a funded testnet EVM account (0x-prefixed,
 *     32 bytes). It must be the SAME account as QORE_MNEMONIC (used by
 *     scripts/window.ts), derived at m/44'/60'/0'/0/0.
 *   - A registered ML-DSA-87 key and a live EVM authorisation window for
 *     that account: run `npm run window register` once, then
 *     `npm run window open`, and wait ~10 seconds before deploying.
 *
 * Safety: this script REFUSES to run on any chain other than the testnet
 * (chain id 9800). SealedBid is a testnet-only project.
 *
 * On success it writes deployments/testnet.json with the contract address
 * and the transaction hashes, so the frontend and the README can point at
 * the live deployment.
 */
import {
  createEvmClient,
  deployContract,
  evmAccountFromPrivateKey,
} from "@qorechain/evm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex } from "viem";

import { sealedBidAbi, sealedBidBytecode } from "../contracts/SealedBid.artifact.js";

/** QoreChain testnet (qorechain-diana) EVM chain id. Nothing else is allowed. */
const TESTNET_CHAIN_ID = 9800;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

import { cosmosHashForEvmTx } from "./qore.js";

async function main(): Promise<void> {
  const evmRpc = process.env.QORE_EVM_RPC_URL ?? "http://localhost:8545";
  const privateKey = requireEnv("QORE_EVM_PRIVATE_KEY") as Hex;

  const client = await createEvmClient({ endpoints: { evmRpc } });
  const chainId = await client.getChainId();
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: chain id is ${chainId}, expected testnet ${TESTNET_CHAIN_ID}. ` +
        `Check QORE_EVM_RPC_URL (testnet: https://evm-testnet.qore.host).`,
    );
  }
  const account = evmAccountFromPrivateKey(privateKey);
  const wallet = client.getWalletClient(account);

  console.log(`network:  QoreChain EVM testnet (chain id ${chainId})`);
  console.log(`deployer: ${account.address}`);

  console.log(`\nDeploying SealedBid…`);
  const deployHash = await deployContract(wallet, {
    abi: sealedBidAbi,
    bytecode: sealedBidBytecode,
    args: [],
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({
    hash: deployHash,
  });
  const contract = receipt.contractAddress;
  if (!contract) {
    throw new Error("Deployment receipt did not include a contract address.");
  }
  console.log(`deployed: ${contract}`);
  console.log(`deploy tx: ${deployHash}`);
  const deployCosmos = await cosmosHashForEvmTx(client.publicClient, deployHash);
  console.log(`explorer: https://explore.qore.network/tx/${deployCosmos.cosmosHash} (switch the explorer to Testnet)`);

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(dir, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const deployment = {
    network: "qorechain-diana",
    chainId: 9800,
    contract: contract as Address,
    deployer: account.address,
    deployTx: deployHash,
    deployTxCosmos: deployCosmos.cosmosHash,
    explorerContract: `https://explore.qore.network/address/${contract}`,
    explorerDeployTx: `https://explore.qore.network/tx/${deployCosmos.cosmosHash}`,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outDir, "testnet.json"),
    JSON.stringify(deployment, null, 2) + "\n",
  );
  console.log("\nWrote deployments/testnet.json");
  console.log("Done.");
}

main().catch((err: unknown) => {
  console.error("\nDeploy failed.");
  console.error(
    "Check QORE_EVM_RPC_URL is reachable, QORE_EVM_PRIVATE_KEY funds an account, " +
      "and a live EVM authorisation window is open (`npm run window status`).",
  );
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
