# QCAI audit — stage 2 triage (25 Nov 2026)

- Audit: QoreChain dashboard QCAI, Blockchain = QoreChain, source
  `flattened/SealedBid.flattened.sol` (253 lines, no test code), run 25 Nov 2026
  ~21:41 WIB — a fresh audit with the IDENTICAL source as stage 1 (the
  dashboard keeps no history).
- Result: **score 75/100, risk MEDIUM, quantum readiness QUANTUM-SAFE,
  4 findings.** Report: `docs/QCAI-audit-stage2.pdf` (verified from the PDF
  itself: score, risk, readiness, and all four titles/severities/
  recommendations match).
- Cost: 150 QOR (testnet), paid ON-CHAIN from the dashboard wallet
  "SealedBid" (`qor14pwajnz3pn6uzxkchjv856q8639m6uve6hwmc4`) — fee tx
  `880A5091…5B5395EF` (CONFIRMED, −150.045 QOR incl. gas; wallet balance
  verified on-chain before/after: 158.83 → 8.785 QOR). The faucet was
  rate-limited at claim time ("Rate Limit Reached — Rate limited for
  another 11:34", next claim ~09:12 WIB 26 Nov), so the wallet was topped
  up 150 QOR from the deployer (tx `7452A153…578E821D`, code 0) before the
  run — faucet alone (100 QOR/24h) could never have funded a 150 QOR audit
  from an 8.83 QOR balance anyway.
- vs stage 1 (same source, 25 Nov ~09:22 WIB): score UNCHANGED 75/100,
  risk UNCHANGED MEDIUM, quantum readiness IMPROVED HYBRID → QUANTUM-SAFE,
  issue count DOWN 5 → 4 — the stage-1 MEDIUM finding "Assumption of
  Public Key Integrity" is ABSENT in stage 2 (nothing to do: the design
  was already documented in the NatSpec and README). The other four
  findings are the same four issues, reworded/retitled.

## Finding 1 — HIGH — Missing ML-KEM Implementation

**Verdict: FALSE POSITIVE / BY DESIGN — no code change.**

Same issue as stage-1 finding 1, reworded. The contract never performs
ML-KEM because the EVM cannot perform ML-KEM — the chain's PQC lives in
the native lane and client-side, which is the documented design (contract
NatSpec trust model, README "Honest limitations", project page
Limitations section). The recommendation asks for "proper verification
mechanisms or explicit warnings about reliance on off-chain decryption":
both already exist. The verification mechanism is the on-chain commitment
check in `revealBid` — `keccak256(abi.encodePacked(amount, salt,
msg.sender)) == b.commitment` must hold before any bid is counted, so the
auctioneer cannot misreport an amount; the winner is decided only from
verified on-chain reveals. The warnings are in the NatSpec ("Bids are
sealed from everyone EXCEPT the auctioneer"), the README, and the page.
Nothing more can be implemented in-contract without an ML-KEM precompile,
which does not exist.

## Finding 2 — MEDIUM — Potential Reentrancy Risk

**Verdict: FALSE POSITIVE — no code change.**

Same issue as stage-1 finding 2. The contract contains ZERO external
calls — no `call`, no `transfer`, no `send`, no cross-contract calls
anywhere in the source. `bidders.push()` in `submitBid` is a plain storage
write to the contract's own array, not an external interaction; there is
nothing to reenter. The finding itself admits the contract is "not
directly vulnerable due to lack of external calls". No funds move through
the contract at all (amounts are recorded in uqor; settlement happens
off-chain), so even a hypothetical future extension could not drain
anything. Checks-effects-interactions is already the pattern used: state
is updated before events are emitted, and no external interaction follows.

## Finding 3 — LOW — No Bid Amount Validation

**Verdict: NOT APPLICABLE — no code change.**

Same issue as stage-1 finding 3. Solidity ^0.8.24 has built-in checked
arithmetic — integer overflow reverts automatically and cannot silently
wrap. Amounts are `uint256` recorded values, not funds; the only
arithmetic on them is comparison (`amount > a.highestBid`). A maximum bid
cap would be an arbitrary product decision, not a security fix, and the
minimum bid (`minBid`, enforced on reveal) is the bound that matters.

## Finding 4 — INFO — Missing Input Sanitization

**Verdict: ACCEPTED RISK (negligible) — no code change.**

Same issue as stage-1 finding 4. The `item` string is supplied by the
auctioneer in their own `createAuction` call; a long string costs the
CALLER gas (they pay for their own calldata and storage). It cannot DoS
other users: no function iterates over `item`, no other user pays for it,
and the string is never read by any bid/reveal/finalise path. A length
check would be cosmetic. Not worth a redeploy that would orphan 15
finalized auctions and the Q-Day Drill proof.

## Summary

0 of 4 findings need a code change: 2 false positives / by design
(findings 1, 2), 1 not applicable (finding 3), 1 accepted risk
(finding 4). No redeploy. Stage 2 confirms stage 1: the contract
enforces auction rules and commitment binding on-chain; encryption lives
client-side by necessity, not by omission — and the auditor now agrees
the project is QUANTUM-SAFE.
