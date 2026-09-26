import { readFileSync, existsSync } from 'fs';
import { Blockchain } from './blockchain';
import { ValidatorSet } from './validatorSet';
import { P2PNode } from './p2p';
import { startApi } from './api';
import { Block } from './block';
import { KeyPair, EncryptedPrivateKey, decryptPrivateKey } from './crypto';
import 'dotenv/config';

const API_PORT = Number(process.env.API_PORT || 3000);
const P2P_PORT = Number(process.env.P2P_PORT || 6000);
const PEERS = (process.env.PEERS || '').split(',').filter(Boolean);
// Which key file this node holds, e.g. "0", "1", "2". Omit to run as a
// non-validating full node (still syncs the chain and accepts transactions).
const VALIDATOR_INDEX = process.env.VALIDATOR_INDEX;
const DATA_FILE = process.env.DATA_FILE || `data/chain-${P2P_PORT}.json`;

// Fixed width of a time slot in ms. Ownership of each slot cycles through
// the validator set based purely on wall-clock time (see
// ValidatorSet.getValidatorForSlot) — this MUST be the same value on every
// node, or nodes will compute different slot numbers for the same moment
// and reject each other's blocks.
const BLOCK_TIMEOUT_MS = Number(process.env.BLOCK_TIMEOUT_MS || 15000);

// Mandatory wait inside each slot before its owner may propose. Like
// BLOCK_TIMEOUT_MS, this MUST match on every node.
const SLOT_WAIT_MS = Number(process.env.SLOT_WAIT_MS || 3000);


if (!existsSync('keys/validators-public.json')) {
  console.error('Missing keys/validators-public.json — run `npm run generate-keys` first.');
  process.exit(1);
}

const publicKeys: string[] = JSON.parse(readFileSync('keys/validators-public.json', 'utf-8'));
const validatorSet = new ValidatorSet(publicKeys);

let myKeys: KeyPair | null = null;
if (VALIDATOR_INDEX !== undefined) {
  const path = `keys/validator-${VALIDATOR_INDEX}.json`;
  if (!existsSync(path)) {
    console.error(`No key file found at ${path}`);
    process.exit(1);
  }

  const passphrase = process.env.VALIDATOR_KEY_PASSPHRASE;
  if (!passphrase) {
    console.error(
      '[node] Missing VALIDATOR_KEY_PASSPHRASE — this validator\'s private key is encrypted\n' +
      '       at rest and cannot be loaded without the passphrase it was generated with.'
    );
    process.exit(1);
  }

  const stored = JSON.parse(readFileSync(path, 'utf-8')) as {
    publicKey: string;
    encryptedPrivateKey: EncryptedPrivateKey;
  };

  try {
    const privateKey = decryptPrivateKey(stored.encryptedPrivateKey, passphrase);
    myKeys = { publicKey: stored.publicKey, privateKey };
  } catch {
    // Fail closed: wrong passphrase or a corrupted/tampered key file both
    // land here (GCM auth tag check fails either way). Never fall back to
    // running unsigned or with a bad key.
    console.error('[node] Failed to decrypt validator private key — wrong VALIDATOR_KEY_PASSPHRASE?');
    process.exit(1);
  }

  console.log(`[node] Running as validator #${VALIDATOR_INDEX}`);
} else {
  console.log('[node] Running as a non-validating full node');
}

const genesisAllocations = existsSync('data/genesis.json')
  ? JSON.parse(readFileSync('data/genesis.json', 'utf-8'))
  : {};

const blockchain = new Blockchain(validatorSet, DATA_FILE, BLOCK_TIMEOUT_MS, SLOT_WAIT_MS, genesisAllocations);
const p2p = new P2PNode(blockchain, P2P_PORT);
p2p.start();

for (const peer of PEERS) {
  p2p.connectToPeer(peer);
}

startApi(blockchain, p2p, API_PORT, myKeys);

// --- Automatic block proposal -----------------------------------------
// Each validator checks, on a short poll, whether (a) there's actually
// something to propose (a non-empty mempool) and (b) it owns the CURRENT
// time slot (see ValidatorSet.getValidatorForSlot). If a slot's assigned
// owner is down, that slot is simply never used — the clock keeps
// advancing, and the next slot belongs to a different validator (`% n`),
// so the rotation naturally moves on without anyone needing to check who's
// "connected" to whom. No manual /propose calls, no grace buffers, no
// offset math: ownership of "now" is a pure function of wall-clock time
// that every node computes identically.
//
// The manual POST /propose endpoint in api.ts still exists and uses the
// exact same slot-ownership check, so it stays useful for forcing an
// immediate proposal during testing/demos.
// --- Automatic block proposal -----------------------------------------
if (myKeys) {
  const POLL_INTERVAL_MS = Math.max(250, Math.floor(blockchain.slotDurationMs / 10));

  setInterval(() => {
    const now = Date.now();
    const currentSlot = blockchain.getSlot(now);

    if (blockchain.pendingTransactions.length === 0) {
      //console.debug(`[auto-propose] tick: mempool empty, nothing to propose (slot ${currentSlot})`);
      return; // nothing to propose
    }

    const waitRemaining = blockchain.getSlotWaitRemaining(now);
    if (waitRemaining > 0) {
      console.debug(`[auto-propose] tick: still in slot wait period, ${waitRemaining}ms remaining (slot ${currentSlot})`);
      return; // still in the wait period
    }

    const latest = blockchain.getLatestBlock();
    const latestSlot = blockchain.getSlot(latest.timestamp);
    if (currentSlot <= latestSlot) {
      console.debug(`[auto-propose] tick: slot ${currentSlot} already used (latest block #${latest.index} is in slot ${latestSlot})`);
      return; // slot already used
    }

    const owner = validatorSet.getValidatorForSlot(currentSlot);
    if (owner !== myKeys!.publicKey) {
      const ownerIndex = validatorSet.getAll().indexOf(owner);
      console.debug(`[auto-propose] tick: slot ${currentSlot} belongs to validator #${ownerIndex}, not me (#${VALIDATOR_INDEX})`);
      return; // not my slot
    }

    const txs = blockchain.selectTransactionsForBlock();
    if (txs.length === 0) return; // nothing valid to propose

    console.log(`[auto-propose] my slot (${currentSlot}) — proposing block #${latest.index + 1} with ${txs.length} pending tx`);

    const block = Block.proposeBlock(
      {
        index: latest.index + 1,
        timestamp: now,
        transactions: txs,
        previousHash: latest.hash,
        validatorPublicKey: myKeys!.publicKey,
      },
      myKeys!.privateKey
    );

    console.debug(`[auto-propose] block #${block.index} built, hash ${block.hash.slice(0, 10)}... — submitting to local chain`);

    const result = blockchain.addBlock(block);
    if (result.success) {
      console.log(`[auto-propose] Proposed block #${block.index} as validator #${VALIDATOR_INDEX} for slot ${currentSlot}`);
      p2p.broadcastNewBlock(block);
      console.debug(`[auto-propose] block #${block.index} broadcast to peers`);
    } else if (!result.alreadyHave) {
      console.warn(`[auto-propose] Attempt for block #${latest.index + 1} rejected locally: ${result.reason}`);
    } else {
      console.debug(`[auto-propose] block #${latest.index + 1} already present locally, skipping broadcast`);
    }
  }, POLL_INTERVAL_MS);

  console.log(`[auto-propose] Enabled — polling every ${POLL_INTERVAL_MS}ms, slot width ${BLOCK_TIMEOUT_MS}ms (3s slot delay enforced)`);
}