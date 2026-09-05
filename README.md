# PoA Blockchain (TypeScript)

A minimal, multi-node Proof-of-Authority blockchain built for learning. It
implements the actual hard parts of a blockchain — hashing, signatures, chain
validation, P2P gossip, and fork resolution — without the complexity of
mining or staking. See the "Where this goes next" section for how to layer
Proof-of-Stake on top of this same codebase.

## Project structure

```
src/
  types.ts          Transaction shape
  crypto.ts         hashing, keypair generation, signing, verification
  block.ts          Block class: hash/sign/validate a single block
  validatorSet.ts   round-robin logic: whose turn is it to sign block N?
  blockchain.ts      chain state, validation rules, longest-valid-chain fork resolution
  p2p.ts            WebSocket networking: peer sync, block/tx gossip
  api.ts            REST API: submit transactions, inspect chain, propose blocks
  node.ts           entry point that wires everything together for one process
scripts/
  generate-keys.ts  generates the shared validator keypairs
```

## Setup

```bash
npm install
npm run generate-keys   # creates keys/validator-0.json, validator-1.json, validator-2.json,
                         # and keys/validators-public.json (the shared rotation order)
```

`keys/validators-public.json` is what every node uses to agree on the
validator set and whose turn it is. In a real deployment this would be
distributed out-of-band (e.g. hardcoded in a genesis config); here it's just
a shared file since everything runs locally.

## Running a 3-node network

Open three terminals:

```bash
npm run node1   # validator #0, API on :3000, P2P on :6000
npm run node2   # validator #1, API on :3001, P2P on :6001
npm run node3   # validator #2, API on :3002, P2P on :6002
```

Each node connects to the other two over WebSocket and syncs chains
automatically on connect. Optionally add a 4th, non-validating observer node:

```bash
npm run fullnode   # API on :3003, P2P on :6003 — just syncs and relays
```

## Trying it out

1. **Submit a transaction** to any node:

   ```bash
   curl -X POST http://localhost:3000/transactions \
     -H "Content-Type: application/json" \
     -d '{"from": "alice", "to": "bob", "amount": 10}'
   ```

   This gets gossiped to all connected peers automatically.

2. **Check whose turn it is** — with 3 validators, block index 1 belongs to
   validator 0, index 2 to validator 1, index 3 to validator 2, then it
   repeats. Trigger the correct node to propose:

   ```bash
   curl -X POST http://localhost:3000/propose
   ```

   If you call `/propose` on the wrong node, you'll get a 409 explaining it's
   not that validator's turn — this is the core PoA rule in action.

3. **Watch the block propagate** — check any other node's chain:

   ```bash
   curl http://localhost:3001/blocks
   ```

   You should see the new block appear there too, without ever posting to
   port 3001 directly.

4. **See overall status**:
   ```bash
   curl http://localhost:3000/status
   ```

## What each design choice teaches you

- **`block.ts`**: separates a block's _content hash_ from its _validator
  signature_ — a common source of confusion. The hash proves the content
  wasn't tampered with; the signature proves who authorized it.
- **`validatorSet.ts`**: the entire "authority" mechanism is just
  `validators[blockIndex % validators.length]`. This is intentionally the
  simplest possible leader-selection rule so you can see the concept clearly
  before adding weighted/random selection (PoS) later.
- **`blockchain.ts` → `isValidNewBlock`**: this is the actual consensus rule
  set. Every node runs the exact same checks, which is what lets independent
  nodes agree without trusting each other directly — they trust the _rules_.
- **`p2p.ts`**: implements the two things every blockchain network needs —
  gossip (gestures at "propagate new data to everyone") and chain sync
  (resolve disagreements using the longest-valid-chain rule). This is
  usually the part tutorials skip, and where the interesting bugs live
  (e.g. what happens if two blocks arrive out of order).

## Known simplifications (intentional, for a learning project)

- No persistent storage — chain lives in memory and resets when a node restarts.
- No mempool deduplication beyond exact-match on `{from, to, amount, timestamp}`.
- `replaceChain` doesn't verify all nodes started from an identical genesis
  block — fine for a single trusted deployment, not fine for a real network.
- No transaction signing/wallets yet — `from`/`to` are just plain strings,
  not actually authenticated. Anyone can submit `{"from": "bob", ...}` and
  claim to be Bob. Real chains sign every transaction with the sender's
  private key, not just blocks with the validator's key.
- Private keys are stored in plaintext JSON files — fine for local learning,
  never do this in anything real.

## Where this goes next: adding Proof-of-Stake

Because `blockchain.ts` and `p2p.ts` don't care _how_ a validator is chosen —
only that `validatorSet.getValidatorForIndex()` returns someone — you can
swap PoA for PoS without touching networking or chain-validation code much:

1. Replace `ValidatorSet` with a `StakeRegistry` that tracks
   `{ publicKey, stakedAmount }[]`.
2. Replace round-robin selection with stake-weighted random selection
   (seed the randomness from the previous block's hash so it's
   deterministic and verifiable by every node).
3. Add a `/stake` and `/unstake` endpoint plus transactions that adjust the
   registry.
4. Add slashing: if `isValidNewBlock` ever detects two different blocks
   signed by the same validator for the same index (equivocation), mark
   that validator as slashed and remove their stake.

Steps 1–3 are a reasonable weekend project on top of this codebase. Step 4
(proper slashing with evidence handling) is where real complexity starts —
worth doing once the rest feels solid.
