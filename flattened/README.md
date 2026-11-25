# SealedBid — flattened contract source for QCAI audit

File: `SealedBid.flattened.sol` — 253 lines, 10,896 bytes.
Generated with hardhat v2.29.2 (`npx hardhat flatten`) from
`contracts/SealedBid.sol` (247 lines, no imports). The body is
byte-identical to the deployed source (verified by diff from the
pragma line onward); no test code is included.

Deployed: 0xefffcd16d4977a3e58340aeee20b10b2e723c585 on qorechain-diana
(chain 9800), deploy tx
0x192e900b95562d4cab25bda35a83feba8cdad241495090ed2e6ec7821486ba7e.

## How to run the audit

1. Open https://dashboard.qorechain.io/audit, sign in with the project account.
2. Start a NEW audit. The form has no file upload — paste the entire
   contents of `SealedBid.flattened.sol` into the "Contract Source Code"
   textarea.
3. Set Blockchain = QoreChain. Run the audit (150 QOR testnet per run,
   dashboard-internal charge; the on-chain wallet balance does not move).
4. Wait for the result. Record score / risk / quantum readiness / findings.
5. Export the PDF and save it as `docs/QCAI-audit-stage1.pdf`
   (stage 2: `docs/QCAI-audit-stage2.pdf`), then triage every finding in
   `docs/QCAI-stage1-triage.md` (stage 2 likewise).

Notes: the dashboard keeps NO audit history and offers NO stage-2 option
on an existing result — stage 2 is a fresh audit with the identical
source. The dashboard failed twice on BillPay Guard's stage 2 on 25 Nov
("No wallet found" toast); if a run fails, do not create a wallet or
import keys — stop and report.

## Auditor context

- Bids are encrypted CLIENT-SIDE with ML-KEM-1024 (FIPS 203) to the
  auctioneer's public key from the chain's x/pqc KEM registry. The EVM
  cannot do ML-KEM, so this contract never encrypts or decrypts: it
  stores sealed bids (ciphertext + AES-GCM blob) and enforces the auction
  rules — bidding deadline, one bid per bidder, a reveal phase where each
  revealed amount is checked against the bidder's commitment
  (keccak256(amount, salt, bidder)), and finalisation.
- Trust model (documented in the README): the auctioneer holds the ML-KEM
  secret key and CAN decrypt at any time — the seal hides bids from other
  bidders and the public, not from the auctioneer. But the auctioneer
  cannot misreport an amount: the winner is decided only from on-chain
  reveals, each verified against the bidder's own commitment.
- NO funds move through this contract. Amounts are recorded in uqor and
  the winner is determined on-chain; settlement happens off-chain between
  winner and auctioneer. There is nothing to steal from the contract.
- Testnet only (qorechain-diana).
