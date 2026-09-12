# Proof of Authority (PoA) Blockchain (TypeScript)

A minimal, multi-node Proof-of-Authority blockchain implementation. It
implements the core mechanics of a blockchain — hashing, signatures, chain
validation, P2P gossip, and fork resolution — without the added complexity
of mining or staking. See the "Where this goes next" section for how to
layer Proof-of-Stake on top of this same codebase.

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

> Note: the number of validator keypairs generated is controlled by
> `NUM_VALIDATORS` in `scripts/generate-keys.ts`. Set it to match the number
> of validator nodes you intend to run (the 3-node example below expects
> `NUM_VALIDATORS = 3`).

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

## Design notes

- **`block.ts`**: separates a block's _content hash_ from its _validator
  signature_. The hash proves the content wasn't tampered with; the
  signature proves who authorized it.
- **`validatorSet.ts`**: the entire authority mechanism is just
  `validators[blockIndex % validators.length]`. This is the simplest
  possible leader-selection rule, ahead of adding weighted/random selection
  (PoS) later.
- **`blockchain.ts` → `isValidNewBlock`**: this is the actual consensus rule
  set. Every node runs the exact same checks, which is what lets independent
  nodes agree without trusting each other directly — they trust the _rules_.
- **`p2p.ts`**: implements the two things every blockchain network needs —
  gossip (propagate new data to everyone) and chain sync (resolve
  disagreements using the longest-valid-chain rule). This is where the
  more interesting edge cases live (e.g. what happens if two blocks arrive
  out of order).

## Known limitations
- No mempool deduplication beyond exact-match on `{from, to, amount, timestamp}`.
- `replaceChain` doesn't verify all nodes started from an identical genesis
  block — fine for a single trusted deployment, not sufficient for an
  open/untrusted network.
- No transaction signing/wallets yet — `from`/`to` are plain strings, not
  authenticated. Anyone can submit `{"from": "bob", ...}` and claim to be
  Bob. Real chains sign every transaction with the sender's private key,
  not just blocks with the validator's key.
