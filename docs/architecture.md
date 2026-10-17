# Architecture

A minimal **Proof-of-Authority** blockchain in TypeScript, with a React console.
Last updated: 2026-10-17. Rules that must match across nodes and the frontend
are in `PROTOCOL.md`; open work is in `TODO.md`.

## The big picture

```
 Browser (React console)
   |  WebSocket API (one URL: the full node, like an RPC URL)
   v
 Full node  <---- p2p (WebSocket mesh) ---->  Validator nodes 0..N-1
 (no keys, observes)                          (hold keys, propose blocks)
```

- **Validators** sign blocks. Slot ownership is a pure function of wall-clock time, so no leader election or liveness checks are needed.
- **Full node** (no `VALIDATOR_INDEX`) validates and relays everything but never proposes. The frontend talks only to this node.
- State (balances, nonces) is **derived**: rebuilt by replaying the chain from genesis, never persisted.

## Core (`src/`)

| File              | Role                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`        | `Transaction` / `UnsignedTransaction` shapes                                                                                                               |
| `crypto.ts`       | sha256, ECDSA secp256k1 sign/verify, keystore create/unlock (AES-256-GCM + PBKDF2), address derivation                                                     |
| `transaction.ts`  | `computeTxHash`, `createSignedTransaction`, `verifyTransaction` (stateless checks only)                                                                    |
| `state.ts`        | `WorldState`: balances + nonces; `applyAll` is atomic (all-or-nothing); `GenesisAllocations`                                                               |
| `block.ts`        | `Block`: hashing, signing, `proposeBlock`, `createGenesisBlock` (genesis commits to allocations + validator order)                                         |
| `validatorSet.ts` | Ordered validator public keys; owner of slot `s` is `validators[s % n]`                                                                                    |
| `blockchain.ts`   | `Blockchain` (EventEmitter): chain, mempool, `WorldState`, slot math, block validation, `addBlock`, `replaceChain` (longest valid chain wins), persistence |
| `storage.ts`      | JSON snapshot of chain + pending txs; written to a temp file then renamed (atomic)                                                                         |
| `p2p.ts`          | `P2PNode`: WebSocket mesh, HELLO handshake, chain sync, gossip of blocks/txs/peers, heartbeat                                                              |
| `peerTable.ts`    | Known peers + health (`lastSeen`, `failures`), bootnodes, blocklist, persistence; address normalisation                                                    |
| `api.ts`          | `startApi`: WebSocket request/response API + topic subscriptions for the frontend                                                                          |
| `nodeInfo.ts`     | Reads `keys/validator-N.json` to discover a validator's own ports                                                                                          |
| `node.ts`         | Entry point: wires everything, runs the auto-propose loop                                                                                                  |

### Wallet layer (core)

| File             | Role                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet.ts`      | `Wallet`: one keystore = one account. **Locked** (encrypted keystore only) or **unlocked** (key in memory, can sign). No files, no network.                          |
| `walletStore.ts` | `WalletStore`: the only code touching `wallets/*.json`. Safe names, no overwrite by default, atomic writes. Loads wallets **locked**.                                |
| `nodeClient.ts`  | `NodeClient`: connect-send-close WebSocket requests (`getAccount`, `submitTransaction`, `getStatus`); `send(wallet, to, amount)` fetches `nextNonce`, signs, submits |

Deliberately WebSocket-only (no HTTP) to keep a single transport.

### Scripts (`scripts/`)

| Script             | npm script      | Purpose                                                                                                    |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------- |
| `generate-keys.ts` | `generate-keys` | Creates `keys/validator-N.json` (keystore + `node` ports) and `keys/validators-public.json`                |
| `reset.ts`         | `reset`         | Wipes `keys/ data/ wallets/`, regenerates keys, creates a funded `test` wallet, writes `data/genesis.json` |
| `start.ts`         | `start`         | Spawns one `node.ts` per validator key file (`-- reset` to reset first)                                    |
| `wallet.ts`        | `wallet`        | CLI over `Wallet` / `WalletStore` / `NodeClient`                                                           |
| `chain-test.ts`    | `test:chain`    | Consensus rules, offline                                                                                   |
| `p2p-test.ts`      | `test:p2p`      | PeerTable unit tests + real nodes over real sockets                                                        |
| `wallet-test.ts`   | `test:wallet`   | Wallet, WalletStore, NodeClient (mock node)                                                                |

## Life of a transaction

1. Wallet signs a tx (nonce = node's `nextNonce`, which counts pending txs too).
2. `submitTransaction` -> `Blockchain.addTransaction` (signature, nonce, balance checks) -> mempool -> gossiped (`NEW_TRANSACTION`).
3. Every ~`slotDuration/10` ms each validator checks: mempool non-empty? wait period over? current slot unused? am I the slot owner? If yes it picks valid txs (`selectTransactionsForBlock`), proposes and signs a block.
4. Block is added locally, then broadcast (`NEW_BLOCK`). Other nodes validate structure + replay txs, add it, prune their mempool and re-broadcast.
5. A node that rejects a block asks the sender for its whole chain (`CHAIN_REQUEST`) and adopts it only if longer and fully valid.

## Configuration

Ports (written into each key file by `generate-keys`): validator `i` uses API `3000+i`, P2P `6000+i`. The full node (`npm run fullnode`) uses API `3099`, P2P `6099`.

| Env var                                                                                   | Used by                    | Meaning                                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `VALIDATOR_INDEX`                                                                         | node                       | Which key file is "me"; unset = full node                                       |
| `VALIDATOR_KEY_PASSPHRASE`                                                                | generate-keys, node, start | Decrypts / encrypts validator keys                                              |
| `BOOTNODES`                                                                               | node                       | Comma-separated `ws://host:port`; default `ws://localhost:6000`                 |
| `BLOCK_TIMEOUT_MS`                                                                        | node                       | Slot width (default 15000). **Must match on all nodes**                         |
| `SLOT_WAIT_MS`                                                                            | node                       | Wait inside a slot before proposing (default 3000). **Must match on all nodes** |
| `API_PORT`, `P2P_PORT`                                                                    | full node                  | Ports when no validator key file                                                |
| `DATA_FILE`, `PEERS_FILE`                                                                 | node                       | Default `data/chain-<p2pPort>.json`, `data/peers-<p2pPort>.json`                |
| `NUM_VALIDATORS`, `BASE_API_PORT`, `BASE_P2P_PORT`                                        | generate-keys              | Defaults 1 / 3000 / 6000                                                        |
| `WALLET_PASSPHRASE`                                                                       | wallet CLI                 | Wallet encryption passphrase                                                    |
| `NODE_URL`                                                                                | wallet CLI / NodeClient    | Default `ws://localhost:3000` (`http://` accepted, treated as `ws://`)          |
| `TEST_WALLET_PASSPHRASE`, `TEST_WALLET_FUNDS`, `GENESIS_ADDRESS`, `GENESIS_ADDRESS_FUNDS` | reset                      | Test wallet + optional extra funded address                                     |
| `VITE_NODE_URL`                                                                           | frontend                   | Default `http://localhost:3099` (the full node)                                 |

Data directories (all gitignore candidates): `keys/` (validator keystores), `data/` (chain snapshots, peer tables, `genesis.json`), `wallets/` (CLI wallets).

## Frontend (React, `react-router`)

```
router.jsx           routes: "/" -> Home, "/wallet" -> Wallet (both inside Layout)
Layout.jsx           NODE_URL, connection-error banner, WalletProvider,
                     <Outlet context={{ nodeUrl, setConnectionError }} />
routes/Home.jsx      subscribes to the node (status/blocks/pending/peers) via api.subscribe,
                     fetches validators once, renders the panels below
routes/Wallet.jsx    wallet management UI (create/import/export/delete, balance)
context/WalletContext.jsx   wallets list, selected wallet, balance/nonce sync from the node
components/
  Header.jsx         title + connection beacon
  StatusPanel.jsx    node status + slot countdown (clock-offset corrected) + proposers
  PeersPanel.jsx     peers; tabs switch between full node and each validator
                     (validators' peers come from a direct WS to their API port)
  TransactionForm.jsx  sign + submit (integer amounts only)
  PendingTable.jsx / BlocksTable.jsx
```

The frontend keeps its own keystore code (noble + browser storage). The only shared contract with the core is the keystore format and the signed-tx format (`PROTOCOL.md`).
