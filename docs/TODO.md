# TODO

Backlog for the PoA blockchain project (core in TypeScript, React frontend).
Last updated: 2026-10-17.

---

## Planned

### 1. Replay protection (chain ID in the signed tx hash) — deferred, bring up when asked

A tx's hash covers only `from, to, amount, nonce, timestamp`, so a tx signed for
one chain is valid on any other chain where that account has the same nonce
(e.g. after `npm run reset` with the same `GENESIS_ADDRESS`).

- Add a chain ID (the genesis block hash is the natural choice) to what `computeTxHash` hashes
- `getStatus` should return it, so clients can learn it
- `Wallet.createTransaction` / `NodeClient.send` need the chain ID (fetch via `getStatus`)
- `verifyTransaction` (or its callers in `blockchain.ts`) must reject a tx for a different chain
- Frontend `lib/transaction` must sign the same fields, in the same order
- **Breaking change:** old txs stop verifying, so run `npm run reset` afterwards
- Update `PROTOCOL.md` (tx hash definition) and add chain-test cases

### 2. Mempool limits

`addTransaction` has no size cap, expiry or per-sender limit, so one client can flood it.

- Max pool size, max pending per sender, optional tx expiry

### 3. Incremental sync

- `CHAIN_RESPONSE` sends the whole chain; the API `blocks` topic re-pushes the whole chain on every block
- Add p2p `GET_BLOCKS { fromIndex }`, and push only new blocks to API subscribers (frontend `Home` then appends instead of replacing)

### 4. Storage

- `persist()` rewrites the full JSON snapshot on every block and every pending tx
- Move to an append-only file or SQLite when chains get long

### 5. Later / bigger

- Transaction fees (also gives the mempool an ordering)
- Validator set changes (currently fixed at genesis)

---

## Cleanup

- [ ] Delete `WebsocketContext.jsx` (placeholder URL, `api.subscribe` signature differs from the one `Home` uses)
- [ ] Remove unused `express`, `cors`, `@types/express`, `@types/cors` from `package.json`
- [ ] `chain-test.ts`: replace its own `makeWallet` with `Wallet.create(...)`
- [ ] `reset.ts`: create the test wallet via `Wallet` + `WalletStore` instead of shelling out to `npm run wallet`
- [ ] Add `"test:wallet": "ts-node scripts/wallet-test.ts"` to `package.json` scripts (if not added yet)

## Wallet / CLI improvements

- [ ] CLI: prompt for the passphrase with hidden input; keep `WALLET_PASSPHRASE` as the fallback for scripts
- [ ] Cross-compat test: a keystore created by the core unlocks in the frontend, and vice versa
- [ ] `NodeClient`: optional persistent connection + reconnect if a long-running bot/service is ever needed
- [ ] Verify `npm run wallet -- balance|send` against a real running node (only tested against a mock so far)

## Frontend ideas

- [ ] Node tabs in `PeersPanel`: also show each node's latest block height/hash (subscribe to `status`) so forks and lagging nodes are visible at a glance
- [ ] Wallet transaction history (scan `blocks` + `pending` for the active address; show pending vs confirmed)
- [ ] `BlocksTable`: show validator names instead of shortened PEM keys (map `publicKey` to `validators[i].name`, as `StatusPanel` does)
- [ ] Block detail route (`/block/:index`) and pagination for `BlocksTable` (it renders the whole chain)
- [ ] `TransactionForm`: validate the **To** field (`/^0x[0-9a-f]{40}$/`) with live feedback, like the amount field

## Known caveats

- `PeersPanel` node tabs need validators that include the `node` section (`apiPort`, `p2pPort`, `validatorIndex`). Key files from before ports were stored need `npm run reset`.
- Node tabs open a direct WebSocket from the browser to each validator's API port. Fine on localhost; behind a firewall they will show the error state.
- Frontend files not shared with Claude so far: `api.js`, `lib/wallet`, `lib/transaction`, `utils/formatters`, `Wallet` route styles. Share them when working on those areas.

---

## Done

- [x] `PeersPanel`: tabs to view peers of the full node or any validator (validators fetched in `Home`, passed down)
- [x] `TransactionForm`: whole-number amount validation (shared `parseAmount`, live hint, disabled Send)
- [x] `Wallet` class (`src/wallet.ts`): create / import / lock / unlock / sign / export
- [x] `NodeClient` (`src/nodeClient.ts`): WebSocket request/response client (fixes the broken HTTP calls in the old CLI)
- [x] `WalletStore` (`src/walletStore.ts`): `wallets/` directory operations, safe names, atomic writes
- [x] `scripts/wallet.ts` rewritten as a thin CLI over the three classes (+ `list` command)
- [x] `scripts/wallet-test.ts`: 42 checks (Wallet, WalletStore, NodeClient against a mock node)
