# Protocol

The rules every node, script and the frontend must agree on. If you change
anything here, update the core **and** the frontend, then run `npm run reset`
(old chains/txs/keystores may stop verifying).
Last updated: 2026-10-19.

---

## 1. Addresses and keys

- Curve: **secp256k1**, ECDSA with SHA-256.
- Public key format: **SPKI PEM** (64-char lines, trailing newline). Canonicalise through Node before hashing (`canonicalPublicKeyPem`) so CRLF / missing newline give the same address.
- **Address** = `"0x" + last 40 hex chars of sha256(canonical public key PEM)`. Lowercase. Regex: `^0x[0-9a-f]{40}$`.
- **Signing:** the signed data is the **hex string** of the hash (not the raw bytes). Signature = DER-encoded ECDSA, hex.

## 2. Transactions

```
{ from, to, amount, nonce, timestamp, publicKey, signature, hash }
```

- `hash = sha256(JSON.stringify({ from, to, amount, nonce, timestamp }))` — **this exact key order**. Also the tx id.
- `signature = sign(hash, privateKey)`; `publicKey` is the sender's SPKI PEM.
- Stateless validity (`verifyTransaction`):
  - `from`, `to` match the address regex; `from !== to`
  - `amount`: positive **safe integer** (no decimals)
  - `nonce`: non-negative safe integer; `timestamp`: safe integer
  - `addressFromPublicKey(publicKey) === from`
  - recomputed hash equals `hash`; signature verifies
- Stateful validity (`WorldState.applyAll`): `nonce` equals the sender's current nonce, and `balance >= amount`. A tx that passes bumps the sender's nonce by 1; the receiver account is created implicitly.
- No fees.

> **Known gap:** the hash has no chain ID, so a tx signed for one chain is valid on another with the same account and nonce. Planned fix in `TODO.md` (replay protection).

### Mempool policy (local, NOT consensus)

These rules decide what a node accepts into its own pending pool and what it
proposes. They are **not** checked in `isValidNewBlock`, so nodes may use
different values without forking, and changing them needs no reset.
Defaults (`DEFAULT_MEMPOOL_OPTIONS` in `blockchain.ts`):

| Rule                                                                        | Default | Rejection reason                                              |
| --------------------------------------------------------------------------- | ------- | ------------------------------------------------------------- |
| Max pending txs in the pool                                                 | 5000    | `mempool is full`                                             |
| Duplicate `hash`                                                            | —       | `duplicate transaction`                                       |
| `nonce` below the confirmed nonce                                           | —       | `nonce already used`                                          |
| Second pending tx with the same `(from, nonce)`                             | —       | `another pending tx from this sender already uses this nonce` |
| Max pending txs per sender                                                  | 64      | `too many pending txs from this sender`                       |
| Nonce window: `nonce < confirmedNonce + maxPendingPerSender`                | 64      | `nonce too far ahead`                                         |
| Cumulative spend: sender's pending amounts + this tx `<= confirmed balance` | —       | `insufficient balance (including pending txs)`                |

- **Check order:** pool size and duplicate hash are checked _before_ signature verification, so a flood doesn't cost an ECDSA verify per tx.
- **Expiry:** a pending tx is dropped 10 minutes (`txTtlMs`) after the node _received_ it. Local arrival time is used, never `tx.timestamp`, which the sender controls. Arrival times are not persisted: txs restored from disk get a fresh 10 minutes.
- **Pruning** (after every block, after a chain replacement, and every 30 s via `sweepMempool()`): drops txs whose nonce was consumed on-chain, expired txs, and txs the sender can no longer afford on top of their lower-nonce pending txs.
- **Restart:** pending txs loaded from `data/chain-*.json` are re-verified (signature and shape) and pruned before use.
- **Block size:** a proposer includes at most 500 txs (`maxTxsPerBlock`), lowest nonces first. This is a proposer-side limit only. Other nodes accept larger blocks.

## 3. Blocks

```
{ index, timestamp, transactions, previousHash, validatorPublicKey, hash, signature }
```

- `hash = sha256(JSON.stringify({ index, timestamp, transactions, previousHash, validatorPublicKey }))` — **this exact key order**, transactions serialised exactly as in the block.
- `signature = sign(hash, validatorPrivateKey)`.
- **Genesis block:** `index 0`, `timestamp 0`, no transactions, `validatorPublicKey = "genesis"`, `signature = "genesis-signature"`, and
  `previousHash = sha256(JSON.stringify({ allocations, validators }))` where `allocations` is `Object.entries(genesis)` **sorted by address** and `validators` is the public-key list **in rotation order**. Different balances or a different validator order therefore give a different genesis hash, and nodes with different genesis refuse each other.
- Genesis allocations come from `data/genesis.json` (`{ "0xaddr": balance }`), identical on every node.

## 4. Consensus rules (`isValidNewBlock`)

A new block `B` after previous block `P` is valid only if all hold:

1. `B.index === P.index + 1`
2. `B.previousHash === P.hash`
3. `B.hash` matches its contents; `B.signature` verifies against `B.validatorPublicKey`
4. `slot(B.timestamp) > slot(P.timestamp)` — one block per slot, slots only move forward
5. `B.timestamp mod slotDurationMs >= slotWaitMs` — not proposed during the wait period
6. `B.timestamp <= now + 2000 ms` — future-drift guard
7. `B.validatorPublicKey === validators[slot(B.timestamp) % n]`
8. All txs valid (section 2) and applied atomically on top of the current state

Definitions: `slot(t) = floor(t / slotDurationMs)`, measured from time 0.
Defaults: `slotDurationMs = 15000`, `slotWaitMs = 3000` (`0 <= slotWaitMs < slotDurationMs`). **Must be identical on every node** — enforced in the p2p handshake.

**Chain selection:** a received chain replaces ours only if it is **strictly longer** and fully replays from genesis (same genesis hash, every block and tx valid). There is no fork-choice beyond length.

**Proposing (not a consensus rule):** a validator proposes when the mempool is non-empty, the wait period is over, the current slot is unused and it owns the slot. It includes at most `maxTxsPerBlock` valid txs (see mempool policy). If an owner is down, that slot is simply skipped.

## 5. Keystore (shared with the frontend)

```json
{
  "version": 1,
  "name": "alice",
  "address": "0x…",
  "publicKey": "<SPKI PEM>",
  "encryptedPrivateKey": {
    "salt": "<hex 16B>",
    "iv": "<hex 12B>",
    "ciphertext": "<hex>"
  }
}
```

- Private key: raw 32-byte secp256k1 scalar.
- KDF: **PBKDF2-SHA256, 250,000 iterations**, 16-byte salt, 32-byte key.
- Cipher: **AES-256-GCM**, 12-byte IV; the 16-byte auth tag is **appended** to the ciphertext.
- Unlock must verify: shape, `address == addressFromPublicKey(publicKey)`, GCM auth (wrong passphrase / tampering), and that the decrypted key derives `publicKey`.
- Validator key files (`keys/validator-N.json`) are the same keystore plus an extra `"node": { validatorIndex, apiPort, p2pPort }` section (ignored by the frontend; `getValidators` returns everything except `encryptedPrivateKey`).

## 6. WebSocket API (`api.ts`)

Port: validator `3000+i`, full node `3099`. Max incoming message 1 MB.

```
request : { id, method, params }
response: { id, result }  |  { id, error: { message, code?, data? } }
push    : { event: <topic>, data }
```

Invalid JSON or a non-object request gets `{ error: { message, code: 400 } }` (no `id`).

| Method                      | Params              | Result                                                                                                                                                                                    |
| --------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getStatus`                 | —                   | chain length, latest block (index/hash/timestamp), pending count, `isValidator`, `serverTime`, `slotDurationMs`, `slotWaitMs`, `currentSlot`, `currentProposerIndex`, `nextProposerIndex` |
| `getBlocks`                 | —                   | full chain                                                                                                                                                                                |
| `getPending`                | —                   | mempool                                                                                                                                                                                   |
| `getValidators`             | —                   | key-file contents minus `encryptedPrivateKey` (includes `node` ports)                                                                                                                     |
| `getPeers`                  | —                   | `{ nodeId, p2pPort, connected: [{address, nodeId, direction}], known: [{address, lastSeen, failures}] }`                                                                                  |
| `getAccount`                | `{ address }`       | `{ address, balance, nonce, nextNonce }` (`nextNonce` counts contiguous pending txs)                                                                                                      |
| `submitTransaction`         | `{ transaction }`   | `{ success, transaction }`; only the 8 known tx fields are kept. Errors with 400 and the mempool rejection reason (section 2) if the tx is refused                                        |
| `propose`                   | —                   | forces a proposal if it is this validator's turn (testing); errors 429 (wait period), 409 (slot used / not your turn), 400 (no keys / nothing to include)                                 |
| `subscribe` / `unsubscribe` | `{ topics: [...] }` | `{ subscribed: [...] }`                                                                                                                                                                   |

Topics: `status`, `blocks`, `pending`, `peers`. On subscribe the server pushes a snapshot of each topic, then pushes again on change (`status` ticks every second; `peers` only when changed). `pending` also changes when stale txs are swept.

Error codes: 400 bad request, 404 unknown method, 409 / 429 propose conflicts, 500 internal.

## 7. P2P protocol (`p2p.ts`)

JSON messages over WebSocket:

| Type                               | Fields                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `HELLO`                            | `nodeId, p2pPort, genesisHash, slotDurationMs, slotWaitMs`                                  |
| `GET_PEERS` / `PEERS`              | `addresses: string[]` (max 50)                                                              |
| `CHAIN_REQUEST` / `CHAIN_RESPONSE` | `chain` (whole chain)                                                                       |
| `NEW_BLOCK`                        | `block`                                                                                     |
| `NEW_TRANSACTION`                  | `transaction` (subject to each receiver's mempool policy; a refused tx is not re-broadcast) |

- A socket is usable only after both sides exchange a compatible `HELLO` (within 5 s). Everything else before that is ignored.
- **Compatible** = same `genesisHash`, same `slotDurationMs`, same `slotWaitMs`, different `nodeId` (self-dials are rejected). Incompatible addresses are blocked.
- One connection per node pair: the one initiated by the node with the lower `nodeId` survives.
- Only **verified** peers (we completed a handshake by dialing them) are shared in `PEERS`; gossiped addresses are candidates until we dial them ourselves.
- Heartbeat ping every 10 s; unresponsive sockets are terminated. Redial uses exponential backoff (1 s up to 30 s); non-bootnode peers are dropped after 10 consecutive failures; table capped at 200 entries.
- Addresses are normalised to `ws://host:port`, with all loopback spellings collapsed to `localhost`.

## 8. Things that silently break compatibility

- Changing the key order in the tx hash or block hash JSON
- Changing PBKDF2 iterations, cipher, or the tag-appended layout
- Different `BLOCK_TIMEOUT_MS` / `SLOT_WAIT_MS` / genesis / validator order between nodes
- Frontend signing code diverging from `computeTxHash` (check `lib/transaction` whenever the core's tx format changes)

Not on this list: mempool limits (section 2). They are local policy and may differ per node.
