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
  crypto.ts         hashing, keypair generation, signing/verification, and
                     AES-256-GCM encryption of private keys at rest
  block.ts          Block class: hash/sign/validate a single block
  validatorSet.ts   round-robin logic: whose turn is it to sign block N?
  blockchain.ts     chain state, validation rules, longest-valid-chain fork
                     resolution, and snapshot persistence via storage.ts
  storage.ts        crash-safe load/save of chain + pending tx to a JSON file
  p2p.ts            WebSocket networking: peer sync, block/tx gossip
  api.ts            REST API: submit transactions, inspect chain, propose blocks
  node.ts           entry point that wires everything together for one process
scripts/
  generate-keys.ts  generates the shared validator keypairs (private keys
                     encrypted at rest; requires VALIDATOR_KEY_PASSPHRASE)
  reset.ts          wipes keys/ and data/, then regenerates keys
  start.ts          reads keys/validators-public.json and spawns one node
                     process per validator automatically
```

## Setup

```bash
npm install

# Private keys are encrypted at rest (AES-256-GCM, key derived from this
# passphrase via scrypt). Pick a passphrase and keep it — you'll need the
# exact same one every time you start a validator node.
VALIDATOR_KEY_PASSPHRASE="correct horse battery staple" npm run generate-keys
```

This creates `keys/validator-0.json`, `keys/validator-1.json`,
`keys/validator-2.json` (each holding a public key plus an encrypted private
key blob — never plaintext) and `keys/validators-public.json` (the shared
rotation order every node uses to agree on the validator set and whose turn
it is).

In a real deployment `keys/validators-public.json` would be distributed
out-of-band (e.g. hardcoded in a genesis config); here it's just a shared
file since everything runs locally.

> Note: the number of validator keypairs generated is controlled by
> `NUM_VALIDATORS` in `scripts/generate-keys.ts`. Set it to match the number
> of validator nodes you intend to run (the 3-node example below expects
> `NUM_VALIDATORS = 3`).

Chain state is also persisted: each node writes its chain and pending
transactions to `data/chain-<p2p-port>.json` (crash-safe write via a temp
file + rename) and restores from it automatically on the next start. Run
`npm run reset` to wipe both `keys/` and `data/` and regenerate fresh keys
in one step.

## Running a 3-node network

### Option A — manual, one terminal per node

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

Every node needs `VALIDATOR_KEY_PASSPHRASE` set in its environment (or a
`.env` file) so it can decrypt its own key — a node will fail fast with a
clear error if it's missing.

### Option B — automatic, one command

`scripts/start.ts` reads `keys/validators-public.json` and spawns one node
process per validator for you, wiring up API/P2P ports and peer lists
automatically:

```bash
VALIDATOR_KEY_PASSPHRASE="correct horse battery staple" npm start
```

Pass `reset` to wipe keys/data and regenerate keys before starting, going
from zero to a running network in one command:

```bash
VALIDATOR_KEY_PASSPHRASE="correct horse battery staple" npm start -- reset
```

Ports default to API `3000+` / P2P `6000+` (one pair per validator, in
order) and can be shifted with `BASE_API_PORT` / `BASE_P2P_PORT`. Ctrl-C
stops all spawned nodes together.

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

- **`crypto.ts`**: validator private keys are never written to disk in
  plaintext. Each key file stores an `EncryptedPrivateKey` blob — a
  passphrase-derived AES-256-GCM key (via scrypt) encrypts the PEM, and the
  GCM auth tag makes decryption fail loudly (rather than silently producing
  garbage) if the passphrase is wrong or the file was tampered with.
- **`block.ts`**: separates a block's _content hash_ from its _validator
  signature_. The hash proves the content wasn't tampered with; the
  signature proves who authorized it.
- **`validatorSet.ts`**: the entire authority mechanism is just
  `validators[blockIndex % validators.length]`. This is the simplest
  possible leader-selection rule.
- **`blockchain.ts` → `isValidNewBlock`**: this is the actual consensus rule
  set. Every node runs the exact same checks, which is what lets independent
  nodes agree without trusting each other directly — they trust the _rules_.
- **`storage.ts`**: each node persists its chain and pending transactions
  to `data/chain-<p2p-port>.json` after every mutation, writing to a temp
  file and renaming into place so a crash mid-write can't corrupt the data
  file. On startup, a node restores from this file if present instead of
  starting from genesis.
- **`p2p.ts`**: implements the two things every blockchain network needs —
  gossip (propagate new data to everyone) and chain sync (resolve
  disagreements using the longest-valid-chain rule). This is where the
  more interesting edge cases live (e.g. what happens if two blocks arrive
  out of order).
