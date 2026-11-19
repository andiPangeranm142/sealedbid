# Threshold opening ceremony (auction 14)

SealedBid's standing caveat is that the auctioneer holds the ML-KEM-1024
secret key and can decrypt any bid at any time. Auction 14 removes that
single point of trust — not by changing the contract (it cannot), but by
changing who holds the key.

## What the contract can and cannot do

Read `contracts/SealedBid.sol` before believing any threshold claim:

- `createAuction()` takes exactly **one** ML-KEM-1024 public key (1568
  bytes) and stores only its `keccak256` hash. There is no parameter for
  keyholders, no threshold, no second key.
- The contract **never decrypts anything**. There is no "open" function:
  the winner is decided only from bidder reveals, each verified against
  the bidder's own commitment.
- There is no upgrade mechanism and no setter for the key hash.

So threshold opening **cannot be enforced on-chain without a redeploy**,
and a redeploy would orphan 14 auctions of history. The threshold is
therefore an **off-chain ceremony, enforced by key custody**. This
document states that plainly; nothing here claims on-chain enforcement
that does not exist.

## The ceremony (auction 14)

1. **Dedicated threshold keypair.** A fresh ML-KEM-1024 keypair was
   generated in memory for auction 14 only
   (`scripts/threshold-auction.ts`). The auctioneer did not reuse their
   registered key.
2. **Split, never stored whole.** The 3168-byte secret key was split
   2-of-3 with Shamir secret sharing over GF(2^8)
   (`src/lib/threshold.ts`). The three shares were written mode 600
   outside the repo (`../threshold/`, plus a backup copy in
   `../threshold-backup/`). **The full secret key was never written to
   disk** — no single party holds it, and the auctioneer cannot decrypt
   auction 14's bids alone.
3. **Public binding.** The public key is published in the auction's
   `AuctionCreated` event and bound on-chain by the auction's
   `kemKeyHash`. Bidders fetch the key from the event logs and verify
   its hash before sealing — the same check the demo UI performs for
   every auction. A `keccak256` commitment of the secret key is
   recorded in `deployments/threshold-auction14.json` so any later
   reconstruction can be verified.
4. **Opening.** Any 2 of the 3 keyholders run
   `npx tsx scripts/threshold-open.ts 14 <shareA> <shareB>`: the shares
   reconstruct the secret key, the commitment is checked, and every
   sealed bid stored on-chain is decrypted and compared against its
   on-chain reveal. One share alone reconstructs nothing — see the
   information-theoretic test in `test/threshold.test.ts`.

## What is true and what is not

| Claim | True? |
| --- | --- |
| Any 2 of 3 keyholders can open auction 14's results | **Yes** — demonstrated live (see below) |
| 1 keyholder alone can open them | **No** — one Shamir share is information-theoretically insufficient (tested) |
| The auctioneer can decrypt auction 14's bids alone | **No** — the full key was never stored; only the 3 shares exist |
| The contract enforces any of this | **No** — the contract is unchanged; the threshold is enforced by key custody (off-chain ceremony) |
| A tampered share can produce a false opening | **No** — reconstruction is verified against the recorded commitment, and a wrong key fails AES-GCM authentication when opening bids |
| The threshold key is in the `x/pqc` registry | **No** — the registry holds one key per account and the auctioneer's registered key must stay in place for auctions 0–13. The binding for auction 14 is the on-chain `kemKeyHash` + the `AuctionCreated` event, which is what bidders verify |

## Demonstration (auction 14, live on Diana)

Full evidence: `deployments/threshold-auction14.json`.

- Auction 14 created with the threshold public key; 3 sealed bids
  (1,000,000 / 1,750,000 / 2,500,000 uqor) submitted on-chain.
- All 3 bids revealed; winner bidder-2 at 2,500,000 uqor; auction
  finalised on-chain.
- Opening ceremony run from the share files on disk (shares 2 + 3):
  reconstruction verified against the recorded commitment, all 3
  sealed bids decrypted, every decrypted amount matching its on-chain
  reveal.

## Operational notes

- Share files are secret material: mode 600, outside the repo, never
  committed, never printed (the scripts log only indices, lengths and
  the verification result). Losing 2 of the 3 shares makes auction 14's
  sealed bids undecryptable — the on-chain reveals still determine the
  winner, so the auction result itself is never at risk.
- The ceremony generalises: `splitSecret`/`reconstructSecret` take any
  threshold ≥ 2 and any share count ≤ 255. Auction 14 uses 2-of-3.
