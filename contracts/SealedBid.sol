// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title SealedBid
/// @notice Sealed-bid auctions for the QoreChain testnet (qorechain-diana).
/// @dev Bids are encrypted CLIENT-SIDE with ML-KEM-1024 (FIPS 203) to the
///      auctioneer's public key, which the auctioneer publishes in the
///      chain's x/pqc KEM registry. The EVM cannot perform ML-KEM natively,
///      so this contract never encrypts or decrypts anything: it stores the
///      sealed bids (ML-KEM ciphertext + AES-GCM blob) and enforces the
///      auction rules — bidding deadline, one bid per bidder, a reveal phase
///      in which each bidder's revealed amount is checked against the
///      commitment they submitted with the sealed bid, and finalisation.
///
///      Trust model (see the README for the full story):
///      - Bids are sealed from everyone EXCEPT the auctioneer, who holds the
///        ML-KEM secret key and can decrypt at any time. The seal hides bids
///        from other bidders and the public, not from the auctioneer.
///      - The auctioneer cannot misreport an amount: the winner is decided
///        only from on-chain reveals, each verified against the bidder's own
///        commitment (keccak256(amount, salt, bidder)).
///      - No funds move through this contract. Bid amounts are recorded in
///        uqor units and the winner is determined on-chain; settlement
///        happens off-chain between winner and auctioneer.
contract SealedBid {
    /// @notice Length of an ML-KEM-1024 ciphertext, in bytes (FIPS 203).
    uint256 public constant KEM_CIPHERTEXT_SIZE = 1568;

    /// @notice Length of an ML-KEM-1024 encapsulation (public) key, in bytes.
    uint256 public constant KEM_PUBLIC_KEY_SIZE = 1568;

    /// @notice Auction lifecycle phases.
    enum Phase {
        Bidding,
        Revealing,
        Finalized
    }

    /// @notice One auction.
    struct Auction {
        address auctioneer;
        string item;
        /// @notice keccak256 of the auctioneer's registered ML-KEM-1024 public
        /// key. Bidders fetch the key (from the x/pqc registry or the
        /// AuctionCreated event) and check its hash against this value before
        /// encrypting, so a bid can only be sealed to the key this auction
        /// names.
        bytes32 kemKeyHash;
        uint256 biddingDeadline;
        uint256 revealDeadline;
        uint256 minBid;
        uint256 highestBid;
        address highestBidder;
        bool finalized;
        address[] bidders;
    }

    /// @notice One sealed bid.
    struct SealedBidData {
        /// @notice ML-KEM-1024 ciphertext (1568 bytes) encapsulating the
        /// shared secret the bid was sealed with.
        bytes kemCiphertext;
        /// @notice AES-256-GCM blob (nonce || ciphertext || tag) holding the
        /// bid's {amount, salt}, encrypted under the ML-KEM shared secret.
        bytes sealedBid;
        /// @notice keccak256(abi.encodePacked(amount, salt, bidder)). The
        /// reveal is verified against this; the auctioneer cannot invent a
        /// different amount for a bid.
        bytes32 commitment;
        uint256 revealedAmount;
        bool revealed;
    }

    /// @notice Number of auctions created so far (also the next auction id).
    uint256 public auctionCount;

    /// @notice Auctions by id.
    mapping(uint256 => Auction) public auctions;

    /// @notice Sealed bids by auction id, then bidder.
    mapping(uint256 => mapping(address => SealedBidData)) public bids;

    /// @notice Whether an address has bid on an auction (one bid per bidder).
    mapping(uint256 => mapping(address => bool)) public hasBid;

    /// @notice Emitted when an auction is created. Carries the full ML-KEM
    /// public key (not just its hash) so browsers — which cannot call the
    /// chain's REST registry from GitHub Pages (no CORS headers) — can read
    /// it from the EVM event logs and verify it against `kemKeyHash`.
    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed auctioneer,
        string item,
        bytes32 kemKeyHash,
        bytes kemPublicKey,
        uint256 biddingDeadline,
        uint256 revealDeadline,
        uint256 minBid
    );

    /// @notice Emitted when a sealed bid lands on-chain.
    event BidSubmitted(uint256 indexed auctionId, address indexed bidder);

    /// @notice Emitted when a bidder reveals. `amount` was verified against
    /// the bidder's commitment before this event was emitted.
    event BidRevealed(uint256 indexed auctionId, address indexed bidder, uint256 amount);

    /// @notice Emitted when an auction is finalised.
    event AuctionFinalized(uint256 indexed auctionId, address winner, uint256 winningBid);

    /// @notice Create an auction.
    /// @param item Human-readable description of what is being auctioned.
    /// @param kemPublicKey The auctioneer's ML-KEM-1024 public key (1568
    ///        bytes), as published in the x/pqc KEM registry. Its hash is
    ///        stored; the key itself is emitted in the event.
    /// @param biddingDuration Seconds the bidding phase stays open.
    /// @param revealDuration Seconds the reveal phase stays open after
    ///        bidding closes.
    /// @param minBid Minimum bid, in uqor units. Bids below it cannot be
    ///        revealed as winning bids (they can still be submitted, but the
    ///        reveal reverts when the amount is below the minimum).
    /// @return auctionId The new auction's id.
    function createAuction(
        string calldata item,
        bytes calldata kemPublicKey,
        uint256 biddingDuration,
        uint256 revealDuration,
        uint256 minBid
    ) external returns (uint256 auctionId) {
        require(kemPublicKey.length == KEM_PUBLIC_KEY_SIZE, "KEM public key must be 1568 bytes");
        require(biddingDuration > 0, "bidding duration must be > 0");
        require(revealDuration > 0, "reveal duration must be > 0");

        auctionId = auctionCount;
        auctionCount += 1;

        Auction storage a = auctions[auctionId];
        a.auctioneer = msg.sender;
        a.item = item;
        a.kemKeyHash = keccak256(kemPublicKey);
        a.biddingDeadline = block.timestamp + biddingDuration;
        a.revealDeadline = block.timestamp + biddingDuration + revealDuration;
        a.minBid = minBid;

        emit AuctionCreated(
            auctionId,
            msg.sender,
            item,
            a.kemKeyHash,
            kemPublicKey,
            a.biddingDeadline,
            a.revealDeadline,
            minBid
        );
    }

    /// @notice Current phase of an auction, derived from the deadlines.
    function phaseOf(uint256 auctionId) public view returns (Phase) {
        Auction storage a = auctions[auctionId];
        if (a.finalized) return Phase.Finalized;
        if (block.timestamp < a.biddingDeadline) return Phase.Bidding;
        if (block.timestamp < a.revealDeadline) return Phase.Revealing;
        // Past the reveal deadline but not yet finalised: still Revealing
        // for read purposes; finalise() is what moves it to Finalized.
        return Phase.Revealing;
    }

    /// @notice Submit a sealed bid.
    /// @param auctionId The auction to bid on.
    /// @param kemCiphertext The ML-KEM-1024 ciphertext (1568 bytes).
    /// @param sealedBid The AES-256-GCM blob holding {amount, salt}.
    /// @param commitment keccak256(abi.encodePacked(amount, salt, bidder)).
    function submitBid(
        uint256 auctionId,
        bytes calldata kemCiphertext,
        bytes calldata sealedBid,
        bytes32 commitment
    ) external {
        Auction storage a = auctions[auctionId];
        require(a.auctioneer != address(0), "auction does not exist");
        require(block.timestamp < a.biddingDeadline, "bidding is closed");
        require(!hasBid[auctionId][msg.sender], "one bid per bidder");
        require(kemCiphertext.length == KEM_CIPHERTEXT_SIZE, "KEM ciphertext must be 1568 bytes");
        require(sealedBid.length > 0, "sealed bid must not be empty");

        hasBid[auctionId][msg.sender] = true;
        a.bidders.push(msg.sender);
        SealedBidData storage b = bids[auctionId][msg.sender];
        b.kemCiphertext = kemCiphertext;
        b.sealedBid = sealedBid;
        b.commitment = commitment;

        emit BidSubmitted(auctionId, msg.sender);
    }

    /// @notice Reveal a bid. Verifies the revealed amount against the
    /// commitment submitted with the sealed bid, then updates the highest
    /// bid if this one beats it.
    /// @param auctionId The auction.
    /// @param amount The bid amount, in uqor units.
    /// @param salt The random salt used in the commitment.
    function revealBid(uint256 auctionId, uint256 amount, bytes32 salt) external {
        Auction storage a = auctions[auctionId];
        require(a.auctioneer != address(0), "auction does not exist");
        require(block.timestamp >= a.biddingDeadline, "bidding is still open");
        require(block.timestamp < a.revealDeadline, "reveal phase is over");
        require(hasBid[auctionId][msg.sender], "no bid to reveal");
        SealedBidData storage b = bids[auctionId][msg.sender];
        require(!b.revealed, "bid already revealed");
        require(
            keccak256(abi.encodePacked(amount, salt, msg.sender)) == b.commitment,
            "amount/salt do not match the commitment"
        );
        require(amount >= a.minBid, "amount is below the minimum bid");

        b.revealed = true;
        b.revealedAmount = amount;
        if (amount > a.highestBid) {
            a.highestBid = amount;
            a.highestBidder = msg.sender;
        }

        emit BidRevealed(auctionId, msg.sender, amount);
    }

    /// @notice Finalise an auction after the reveal deadline. Anyone may
    /// call it; the winner is whoever revealed the highest bid (or nobody,
    /// if no bid was revealed).
    function finalize(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.auctioneer != address(0), "auction does not exist");
        require(!a.finalized, "already finalised");
        require(block.timestamp >= a.revealDeadline, "reveal phase is not over yet");
        a.finalized = true;
        emit AuctionFinalized(auctionId, a.highestBidder, a.highestBid);
    }

    /// @notice Bidders of an auction, in bid order.
    function getBidders(uint256 auctionId) external view returns (address[] memory) {
        return auctions[auctionId].bidders;
    }

    /// @notice Number of bids on an auction.
    function bidCount(uint256 auctionId) external view returns (uint256) {
        return auctions[auctionId].bidders.length;
    }
}
