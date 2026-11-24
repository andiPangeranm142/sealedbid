# AI Usage — SealedBid

This file documents how AI was used to build SealedBid, what the AI
generated, what the human contributed, and how the work was verified. It
exists for the QoreChain Developer Fest's **Best AI-Native Build** award,
and as an honest development record.

## Summary

SealedBid was built end-to-end by an AI coding agent (**Muse**, running as
the assistant "forza") from a one-line human request ("build a sealed-bid
auction for the Encrypted Apps category"), over a single build session on
15–16 November 2026. The human (Aeron) chose the event and the category,
approved the approach, and owns every step that needs a human identity:
accounts, funding, registration, and submission. No code was copied from
any other fest project — the concept (ML-KEM-1024 sealed bids + on-chain
commitment-verified reveals) is original to this project, and was checked
against the projects already listed on build.qorechain.io before building
began.

## Workflow

1. **Research first, code second.** The agent read the fest site (category
   requirements: ML-KEM-1024 encryption, registered recipient keys, ML-DSA
   key binding, client-side encryption/decryption), the QoreChain SDK type
   definitions (which showed the SDK has a KEM *registry* but no KEM
   *crypto* — so a JS ML-KEM implementation was needed), and the sibling
   project Quantum Flip's proven deployment scripts before writing anything.
2. **Scaffold from proven patterns.** The project reuses Quantum Flip's
   verified patterns (window management, deployment + Cosmos-hash
   translation, Ganache contract tests, Vite + RainbowKit frontend) with
   attribution in the README's Credits section. The contract, the crypto
   module, the KEM-registry scripts, the UI, and the tests are original.
3. **Never guess an API.** Every SDK/EVM function used was checked against
   the type definitions in `node_modules` before use — including
   `msg.pqc.registerKemKey` (hybrid-signed, needs the ML-DSA key first),
   `fetchKemKey`, `validateKemPublicKey` (1568-byte + FIPS 203 modulus
   check), and the noble ML-KEM / AES-GCM APIs.
4. **Verify at every step.** Contract compiled with `solc` 0.8.24;
   artifact regenerated from compiler output by script (never
   hand-copied); `tsc --noEmit` typecheck; 41 automated tests (contract
   behaviour on a local EVM + crypto unit tests + threshold-opening
   tests, including tamper detection); `vite build` for the frontend.
   On-chain verification was done the same day: the contract deployed at
   `0xefffcd16d4977a3e58340aeee20b10b2e723c585`, the auctioneer's ML-KEM
   public key published in the `x/pqc` registry and read back, and a full
   two-bidder auction run end-to-end on Diana with every transaction hash
   recorded in `deployments/e2e.json`. Since then 15 auctions have been
   created and all finalized on Diana, including a 2-of-3 threshold
   ceremony for auction 14 (19 Nov 2026) and the Q-Day Drill lot
   (auction 13, revealed 20 Nov, finalized 21 Nov). Nothing in this repo
   claims an on-chain result that has not happened.
5. **Secrets discipline.** A fresh testnet-only wallet was generated for
   this project; its mnemonic and private key live only in the local,
   git-ignored `.env` (mode 600) and a mode-600 file outside the repo. The
   auctioneer's ML-KEM secret key and the bidder mnemonics likewise live
   only in mode-600 files outside the repo. The repo was checked for
   secrets before every commit (see below).

## What the AI generated

- `contracts/SealedBid.sol` — the auction contract (original design: sealed
  bids + commitment-verified reveals + finalisation).
- `src/lib/kem.ts` — the client-side ML-KEM-1024 + AES-256-GCM sealing
  module (shared by the browser UI and the Node scripts).
- `scripts/qore.ts` — shared native-lane helpers (PQC registration,
  windows, funding, KEM publication, Cosmos-hash translation).
- `scripts/register-kem.ts` — auctioneer KEM keypair management and
  registry publication.
- `scripts/deploy.ts`, `scripts/e2e.ts`, `scripts/fund.ts` — deployment,
  full on-chain auction run, funding helper.
- `scripts/threshold-auction.ts`, `scripts/threshold-ceremony.ts`,
  `scripts/threshold-open.ts` — the threshold auction setup, the Shamir
  2-of-3 ceremony (auction 14, 19 Nov 2026: the ML-KEM-1024 secret key
  was split into 3 shares and never written to disk), and share-based
  bid opening.
- `scripts/drill-bid.ts`, `scripts/drill-reveal.ts`,
  `scripts/finalize-drill.ts`, `scripts/finalize.ts`,
  `scripts/state-check.ts` — the Q-Day Drill bid / reveal / finalize,
  auction finalization, and on-chain state checks.
- `test/sealedbid.test.ts`, `test/kem.test.ts` — contract tests (15
  tests: full auction lifecycle, negative cases) and crypto unit tests
  (12 tests).
- `test/threshold.test.ts` — threshold-opening tests (14 tests: 2-of-3
  shares open a sealed bid, 1 share cannot, tampered shares fail GCM
  authentication).
- `src/*` — the React frontend (browse / create / bid / reveal / finalise,
  in-browser encryption, auctioneer local decryption).
- `scripts/make-cover.py` — the featured-image generator.
- `README.md`, this file, `.gitignore`, `.env.example`, `LICENSE`.

## What the human contributed

- Chose the fest, the category (Encrypted Apps), and the concept direction
  ("sealed-bid auction with ML-KEM-1024").
- Owns the GitHub account (`andiPangeranm142`), the fest registration, and
  the project-page submission.
- Reviewed the deliverables and made the go/no-go decisions.

## Verification

- `npm test` — 41 tests passing (15 contract + 12 crypto + 14
  threshold; run locally before every deploy).
- `npm run typecheck` — clean.
- `npm run compile` — solc 0.8.24, 4,916 bytes of bytecode.
- On-chain: contract deployed on Diana; KEM key registered in `x/pqc` and
  read back (hash matches); full E2E auction verified (see
  `deployments/e2e.json`); 15 auctions created and all finalized.
- Threshold ceremony (auction 14, 19 Nov 2026): the ceremony opened all
  3 bids from shares 2 and 3, with every decrypted amount matching its
  on-chain reveal (see `deployments/threshold-auction14.json`).
- Q-Day Drill lot (auction 13): sealed bid submitted on drill day,
  revealed 20 Nov 2026, finalized 21 Nov 2026 (see
  `deployments/drill-bid.json`, `deployments/drill-finalize.json`).
- Live demo render-checked with Playwright after deployment (no console or
  page errors).
- Demo video: real screen recording of the live demo, duration verified
  with ffprobe (≤3 min).

## Secret check

Before each commit, the staged files were checked for secrets:

```bash
git diff --cached --name-only   # .env, *.json key files must never appear
grep -R "QORE_EVM_PRIVATE_KEY=0x[1-9a-f]" --include="*.ts" --include="*.md" . || true
```

The `.env` file, `auctioneer-kem.json`, `bidders.json`, and
`deployer.json` all live outside the repo (or git-ignored) with mode 600.
Only `.env.example` (placeholders) is committed.
