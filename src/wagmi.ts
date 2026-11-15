import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { qorechain, qorechainTestnet } from "@qorechain/evm";
import { qorexWallet } from "@qorechain/qorex-rainbowkit";
import type { Chain } from "viem";
import { createConfig, http } from "wagmi";

// @qorechain/evm was typed against an older viem whose
// PrepareTransactionRequestPhase had three phases; viem 2.57 added a fourth
// ("afterFillTransactionError"), so the SDK's chain type no longer satisfies
// wagmi's Chain. The runtime chain objects carry no prepareTransactionRequest
// at all, so this cast changes nothing at runtime — it only bridges the
// type-level drift between the SDK and the repo's viem.
const testnet = qorechainTestnet as unknown as Chain;
const mainnet = qorechain as unknown as Chain;

// QoreX first, then any other injected (EIP-1193) wallet. Neither uses
// WalletConnect, so the project id is only a placeholder unless you add a
// WalletConnect-based wallet.
const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [() => qorexWallet({ pollAccountsOnFocus: true }), injectedWallet],
    },
  ],
  {
    appName: "SealedBid",
    projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "unused",
  },
);

// The testnet is listed first, so a fresh connection lands there.
export const config = createConfig({
  chains: [testnet, mainnet],
  connectors,
  transports: {
    [testnet.id]: http(),
    [mainnet.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
