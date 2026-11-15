/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Deployed SealedBid contract address on the QoreChain testnet. Empty when not yet deployed. */
  readonly VITE_SEALEDBID_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
