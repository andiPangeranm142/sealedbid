# QCAI audit — stage 1 triage (25 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/SealedBid.flattened.sol` (253 lines, no test code), run 25 Nov 2026
  ~09:22 WIB.
- Result: **score 75/100, risk MEDIUM, quantum readiness HYBRID,
  5 findings.** Report: `docs/QCAI-audit-stage1.pdf` (verified from the PDF
  itself: score, risk, readiness, and all five titles/severities/
  recommendations match).
- Cost: 150 QOR (testnet), paid ON-CHAIN from the dashboard wallet
  "SealedBid" (`qor14pwajnz3pn6uzxkchjv856q8639m6uve6hwmc4`) — fee tx
  `48F0E3AB…CA654A96` (CONFIRMED, −150.045 QOR incl. gas; wallet balance
  verified on-chain before/after: 159.01 → 8.965 QOR). NOTE: the fee is a
  real on-chain MsgSend, not internal-only billing — the first two attempts
  failed with "insufficient funds" because the fresh faucet-funded wallet
  held only ~99 QOR (faucet gives 100 QOR/24h); topped up 60 QOR from the
  deployer (tx `10A8B563…67FD00`, code 0) before the successful run.
- Context: below Quantum Vault's 85/100 (x2) and Fenestella's 85/100 (x2),
  above BillPay Guard's 72/100. The HIGH finding is the same class as
  BillPay Guard's HIGH (no on-chain PQC verification) — a documented
  architectural choice, not an oversight. Stage 2 is a fresh audit with
  identical source (the dashboard keeps no history); stage 2 NOT yet run.

## Finding 1 — HIGH — Missing Quantum-Safe Encryption Implementation

**Verdict: FALSE POSITIVE — the recommended check already exists; no code
change.**

The recommendation asks for "a verification mechanism within the contract
to validate that the commitment matches the actual bid data". That
mechanism already exists: `revealBid` requires
`keccak256(abi.encodePacked(amount, salt, msg.sender)) == b.commitment`
before any bid is counted — the on-chain commitment check validates the
revealed amount against the sealed bid data. A Merkle tree would add
nothing here (one bid per bidder, direct hash check). As for
"quantum-safe operations directly in Solidity": the EVM cannot perform
ML-KEM — the chain's PQC lives in the native lane and client-side, which
is the documented design (contract NatSpec, README "Honest limitations",
project page). The trust assumption on clients is stated openly, and the
auctioneer cannot misreport an amount because the winner is decided only
from on-chain reveals verified against commitments.

## Finding 2 — MEDIUM — Potential Reentrancy Risk via External Calls

**Verdict: FALSE POSITIVE — no code change.**

The contract contains ZERO external calls — no `call`, no `transfer`, no
`send`, no cross-contract calls anywhere in the source (verifiable by
reading it: the only effects are storage writes and events). There is
nothing to reenter. The finding itself admits "there are no direct
external calls in the core logic" and worries only about hypothetical
future extensions. No funds move through the contract at all (amounts are
recorded in uqor; settlement happens off-chain), so even a future
extension could not drain anything. Checks-effects-interactions is already
the pattern used: state is updated before events are emitted, and no
external interaction follows.

## Finding 3 — LOW — No Validation on Bid Amount Range

**Verdict: NOT APPLICABLE — no code change.**

Solidity ^0.8.24 has built-in checked arithmetic — integer overflow reverts
automatically and cannot silently wrap, so the "overflow" concern does not
apply. Amounts are `uint256` recorded values, not funds; the only
arithmetic on them is comparison (`amount > a.highestBid`). A maximum bid
cap would be an arbitrary product decision, not a security fix, and the
minimum bid (`minBid`, enforced on reveal) is the bound that matters.

## Finding 4 — INFO — Missing Input Sanitization for String Parameters

**Verdict: ACCEPTED RISK (negligible) — no code change.**

The `item` string is supplied by the auctioneer in their own
`createAuction` call; a long string costs the CALLER gas (they pay for
their own calldata and storage). It cannot DoS other users: no function
iterates over `item`, no other user pays for it, and the string is never
read by any bid/reveal/finalise path. A length check would be cosmetic.
Not worth a redeploy that would orphan 15 finalized auctions and the Q-Day
Drill proof.

## Finding 5 — MEDIUM — Assumption of Public Key Integrity

**Verdict: ACCEPTED BY DESIGN — documented limitation; no code change.**

The contract stores `keccak256(kemPublicKey)` and emits the full 1568-byte
key in `AuctionCreated`; bidders fetch the key and verify its hash against
`kemKeyHash` before encrypting (documented in the NatSpec and README).
The EVM cannot query the x/pqc KEM registry — there is no precompile for
it, and registry reads are client-side/REST by design. The residual risk
is an auctioneer publishing a key they do not hold the secret for — but
that only harms the auctioneer (they cannot open bids), and bidders lose
nothing because no funds ever enter the contract.

## Summary

0 of 5 findings need a code change: 2 false positives (findings 1, 2),
1 not applicable (finding 3), 2 accepted by design / negligible risk
(findings 4, 5). No redeploy. The audit confirms the documented security
story: the contract enforces auction rules and commitment binding
on-chain; encryption lives client-side by necessity, not by omission.
