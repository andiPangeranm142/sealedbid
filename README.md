# SealedBid

Sealed-bid auctions on the QoreChain testnet (qorechain-diana), built for the
**QoreChain Developer Fest** ("Build Before Q-Day") — **Encrypted Apps**
category.

Bids are encrypted **client-side** with **ML-KEM-1024** (NIST FIPS 203) to the
auctioneer's public key, published in the chain's `x/pqc` KEM registry. Only
ciphertext goes on-chain, so bids stay sealed until the reveal phase — while
the contract enforces the auction rules and verifies every reveal against the
commitment submitted with the sealed bid.

- **Live demo:** https://andipangeranm142.github.io/sealedbid/
- **Contract (Diana testnet):** `0xefffcd16d4977a3e58340aeee20b10b2e723c585`
  ([explorer](https://explore.qore.network/address/0xefffcd16d4977a3e58340aeee20b10b2e723c585) — switch to Testnet)
- **Demo video:** [`docs/demo.mp4`](docs/demo.mp4) (≤3 min, real screen recording)

## How it works

1. **Auctioneer publishes a key.** The auctioneer generates an ML-KEM-1024
   keypair and publishes the public key in the chain's `x/pqc` KEM registry
   (`MsgRegisterKEMKey`, hybrid-signed — see [Key binding](#key-binding)).
2. **Auction is created on-chain.** `createAuction(item, kemPublicKey, …)`
   stores the keccak256 hash of the auctioneer's public key and emits the
   full key in the `AuctionCreated` event. Bidding and reveal deadlines are
   set in seconds.
3. **Bidders seal their bids.** In the browser (or a script), the bidder
   fetches the auctioneer's public key, checks its hash against the auction's
   recorded hash, then seals the bid: ML-KEM-1024 encapsulation produces a
   shared secret, and AES-256-GCM encrypts the payload `{amount, salt}` under
   it. The bidder submits the 1568-byte KEM ciphertext, the AES-GCM blob, and
   a commitment `keccak256(amount, salt, bidder)` — one bid per bidder, only
   while the bidding phase is open.
4. **Reveal.** After the bidding deadline, each bidder reveals `(amount,
   salt)`. The contract checks the reveal against the stored commitment and
   updates the highest bid. A wrong amount or salt is rejected.
5. **Finalise.** After the reveal deadline, anyone can call `finalize()`.
   The highest revealed bid wins; with no reveals, there is no winner.

## What runs on-chain vs client-side (read this)

| Step | Where | Notes |
| --- | --- | --- |
| ML-KEM-1024 key generation, encapsulation, decapsulation | Client-side (browser / scripts) | `@noble/post-quantum`, pure JS. The EVM has no ML-KEM precompile. |
| AES-256-GCM sealing of `{amount, salt}` | Client-side | `@noble/ciphers`, keyed by the ML-KEM shared secret. |
| KEM public-key publication | On-chain, native lane | `x/pqc` KEM registry (`MsgRegisterKEMKey`). The chain stores and serves the raw key only; encryption is not part of the SDK or the chain. |
| Storing sealed bids, deadlines, one-bid-per-bidder, reveal verification, winner | On-chain, EVM | `contracts/SealedBid.sol`. The contract never encrypts or decrypts anything. |

**The EVM never decrypts.** Nothing in this project implies otherwise: the
contract stores ciphertexts and commitments and enforces the rules; all
cryptography happens off-chain. The auctioneer decrypts sealed bids locally
with their ML-KEM secret key (the demo UI offers a "Decrypt (local)" button
for the auctioneer).

## Trust model and limitations

- **Bids are sealed from everyone except the auctioneer.** The auctioneer
  holds the ML-KEM secret key and can decrypt any bid at any time — the seal
  hides bids from other bidders and the public, not from the auctioneer.
  The auctioneer is trusted not to leak bids early or to front-run them.
- **The auctioneer cannot misreport an amount.** The winner is decided only
  from on-chain reveals, each verified against the bidder's own commitment.
  Decrypted amounts are for display and audit only.
- **No funds move through the contract.** Bid amounts are recorded in uqor
  units and the winner is determined on-chain; the contract holds no funds
  and settlement happens off-chain between winner and auctioneer. Escrowed
  bidding is future work (see below).
- **Keys in the browser are demo-grade.** A keypair generated in the demo UI
  keeps its secret key in the browser's local storage, and each bid's reveal
  salt is stored the same way. That is fine for a testnet demo and
  unacceptable for real stakes: clear storage (or lose the salt) and a bid
  can never be revealed.
- **Reveal liveness.** A bidder who never reveals simply does not count
  toward the result; there is no penalty for non-reveal in this version.
- **No front-running protection on reveals.** Reveals are public
  transactions; a bidder can see another's revealed amount before revealing
  their own — but they cannot change their amount, because the commitment
  binds it.

### Key binding

Each auction records `keccak256` of the auctioneer's ML-KEM-1024 public key.
The key itself is published in the `x/pqc` KEM registry by a hybrid-signed
message (`MsgRegisterKEMKey`), which requires the account to already hold a
registered ML-DSA-87 key — so the KEM key is bound to the same account (and
therefore the same ML-DSA key) that publishes it. Bidders verify the key
they encrypt to against the auction's recorded hash before sealing; a
mismatched key is refused.

The demo UI reads the public key from the `AuctionCreated` event logs rather
than the REST registry, because the chain's REST endpoints send no CORS
headers and the demo is served from GitHub Pages. The event carries the full
key; the hash check is what makes that copy trustworthy.

## Live deployment (Diana testnet)

- Contract: `0xefffcd16d4977a3e58340aeee20b10b2e723c585`
- Deploy tx (EVM): `0x192e900b95562d4cab25bda35a83feba8cdad241495090ed2e6ec7821486ba7e`
- Deploy tx (Cosmos): `43CD12CA55D5B39C7620A3956A42504BB5C9CF70EEE39AFDB8D859C05B60F3C4`
- Deployer / auctioneer: `0xB5e7E335226D56Ca2Bd38FDEb18169A8C004185E`
- KEM key registration tx (Cosmos): `23E29A2758BE7C4344750C2801632AB1628F43815CA18D12BE67996D11C9D6EB`
- KEM public key hash: `0x49743e1ea3deea9e19828ca870cf42d021ff662d3b4c852e04db3ce6ae1f513f`
- PQC (ML-DSA-87) key registration tx (Cosmos): `A5B19E51C766C5972CC0E46C4D5E01AA2A129DA66C4E11DF406FFE27E096869B`

See [`deployments/testnet.json`](deployments/testnet.json) and
[`deployments/e2e.json`](deployments/e2e.json) for the full records.

## End-to-end auction (real, on-chain)

`npm run e2e` runs a complete auction on Diana: two fresh bidder accounts
(funded, ML-DSA-registered, windowed) seal bids of 1,000,000 and 2,500,000
uqor, reveal after the bidding deadline, and the auction is finalised with
bidder-2 winning at 2,500,000 uqor. The auctioneer then decrypts both sealed
bids off-chain and the decrypted amounts are checked against the on-chain
reveals. Every transaction hash is recorded in
[`deployments/e2e.json`](deployments/e2e.json).

## Development

Prerequisites: Node.js 20+, npm. The deployer account is a fresh
testnet-only wallet; its mnemonic and private key live only in the local,
git-ignored `.env` (mode 600) and a mode-600 file outside the repo. Never
commit them.

```bash
npm install

# Contract
npm run compile        # solc 0.8.24 -> contracts/SealedBid.artifact.ts
npm test               # contract tests (Ganache) + crypto unit tests
npm run typecheck

# On-chain (testnet only; .env from .env.example)
npm run window -- register    # ML-DSA-87 key (once; the account's first tx)
npm run register-kem -- generate   # auctioneer ML-KEM-1024 keypair (outside the repo)
npm run register-kem -- register   # publish the public key in the x/pqc registry
npm run window -- open             # EVM authorisation window
npm run deploy                     # deploy SealedBid -> deployments/testnet.json
npm run e2e                        # full on-chain auction (~6 min)

# Frontend
npm run dev    # vite dev server (http://localhost:5173)
npm run build  # production build (contract address via VITE_SEALEDBID_ADDRESS)
```

### Why the EVM window matters

On QoreChain, every EVM transaction is admitted only inside a post-quantum
authorisation window, opened by a hybrid-signed (secp256k1 + ML-DSA-87)
native message. An account needs a registered ML-DSA-87 key first (its very
first transaction), then a live window. Without one, the chain refuses EVM
transactions — see `scripts/window.ts` and the README's window section in
the demo UI. Registration and windows are native-lane operations; the demo
UI cannot do them from the browser, so it tells the user to open a window
from QoreX.

### Lessons from the testnet (things that bit us)

- **Cap your fees explicitly.** The chain's fee market is volatile: viem's
  uncapped `maxFeePerGas` estimate spiked to ~2000–6000 gwei during
  testing, and a window admits a transaction only when
  `gasLimit x maxFeePerGas` fits its remaining value — so uncapped bids
  were rejected with `gas required exceeds allowance`. The UI and scripts
  set an explicit 150 gwei cap (base fee sits at ~100 gwei) and explicit
  gas limits. A sealed bid uses ~1.37M gas, mostly storing the 1568-byte
  ML-KEM ciphertext; budget 1.5M gas per bid.
- **A window's value is shared across its transactions**, and opening one
  costs ~0.1 QOR in native gas (hybrid-signature verification is
  expensive). Size windows for the fees of every transaction they must
  admit, and reuse a live window instead of opening a fresh one per run.
- **The `auctions` getter omits `bidders`.** Solidity's auto-generated
  getter for a struct containing a dynamically-sized array does not return
  that array — reading `auctions(...)[9]` is `undefined` and crashed the
  UI. Read the bidder list through the explicit `getBidders(auctionId)`
  view function.
- **Keep React keys stable across transactions.** The receipt effect calls
  `onChanged()`; when the card key included a refresh counter, the card
  remounted the moment a transaction confirmed and wiped the
  `useWriteContract` state — the transaction landed on-chain but
  "Confirmed." never survived a frame. Refresh data with
  `queryClient.invalidateQueries()`, never by remounting.
- **Vite's proxy ignores `https_proxy`.** In sandboxed networks the
  `/lcd-*` proxy must route through the egress proxy explicitly (an
  `HttpsProxyAgent` in `vite.config.ts`), or every window-status request
  fails with a TLS "wrong version number" error.

## Project layout

```
contracts/SealedBid.sol     The auction contract (rules + storage, no crypto)
contracts/SealedBid.artifact.ts  ABI + bytecode, generated by `npm run compile`
src/lib/kem.ts              Client-side ML-KEM-1024 + AES-GCM sealing (browser + Node)
src/App.tsx                 React demo (browse / create / bid / reveal / finalise)
scripts/window.ts           PQC registration + EVM window management
scripts/register-kem.ts     Auctioneer KEM keypair + x/pqc registry publication
scripts/deploy.ts           Deployment + deployment record
scripts/e2e.ts              Full on-chain auction run + evidence record
scripts/fund.ts             Native QOR funding helper
test/kem.test.ts            Crypto unit tests
test/sealedbid.test.ts      Contract tests on a local Ganache chain
deployments/                Live deployment + E2E evidence (testnet.json, e2e.json)
docs/demo.mp4               Demo video (real screen recording, ≤3 min)
docs/featured.png           Featured image for the fest project page
```

## Future work

- Escrowed bidding: bidders lock their bid amount when submitting (payable
  bids), losers are refunded at finalisation, and the winner's funds go to
  the auctioneer.
- Non-reveal penalties (e.g. a small bond forfeited when a bid is not revealed).
- Threshold decryption: split the ML-KEM secret key so no single auctioneer
  can read bids early.

## Credits

- ML-KEM-1024 and AES-GCM: [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum)
  and [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) (audited, pure JS).
- Chain interaction: [`@qorechain/sdk` and `@qorechain/evm`](https://www.npmjs.com/package/@qorechain/sdk)
  0.14.0 (KEM registry, ML-DSA registration, EVM windows, EVM client).
- The window and deployment scripts follow the patterns of the official
  QoreChain templates and of the sibling project Quantum Flip (same author,
  same fest); the SealedBid contract, crypto module, UI, and tests are
  original to this project.

## License

Apache-2.0. See [LICENSE](LICENSE).
