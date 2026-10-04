import { WebSocketServer, WebSocket, RawData } from 'ws';
import fs from 'fs';
import path from 'path';
import { Blockchain } from './blockchain';
import { P2PNode } from './p2p';
import { Block } from './block';
import { Transaction } from './types';
import { KeyPair } from './crypto';

/**
 * WebSocket API (replaces the Express REST API). Same port as before.
 *
 * Client -> server (request):   { id, method, params }
 * Server -> client (response):  { id, result }  |  { id, error: { message, code?, data? } }
 * Server -> client (push):      { event: <topic>, data }
 *
 * Topics a client can subscribe to: status, blocks, pending, peers.
 * On subscribe the server immediately pushes the current snapshot of each
 * topic, then pushes again whenever it changes.
 */

type Topic = 'status' | 'blocks' | 'pending' | 'peers';
const TOPICS: Topic[] = ['status', 'blocks', 'pending', 'peers'];

const STATUS_PUSH_INTERVAL_MS = 1000; // slot info is time-based, so status ticks
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_INCOMING_BYTES = 1 << 20; // 1 MB

class ApiError extends Error {
  constructor(message: string, public code = 400, public data?: any) {
    super(message);
  }
}

export function startApi(
  blockchain: Blockchain,
  p2p: P2PNode,
  apiPort: number,
  myValidatorKeys: KeyPair | null
) {
  const wss = new WebSocketServer({ port: apiPort, maxPayload: MAX_INCOMING_BYTES });
  const subscriptions = new Map<WebSocket, Set<Topic>>();
  const alive = new WeakMap<WebSocket, boolean>();

  // --- snapshots ----------------------------------------------------------

  function getStatus() {
    const latest = blockchain.getLatestBlock();
    const now = Date.now();
    const currentSlot = blockchain.getSlot(now);
    return {
      chainLength: blockchain.chain.length,
      latestBlockIndex: latest.index,
      latestBlockHash: latest.hash,
      latestBlockTimestamp: latest.timestamp,
      pendingTransactions: blockchain.pendingTransactions.length,
      isValidator: myValidatorKeys !== null,
      serverTime: now,
      slotDurationMs: blockchain.slotDurationMs,
      slotWaitMs: blockchain.slotWaitMs,
      currentSlot,
      currentProposerIndex: blockchain.validatorSet.getIndexForSlot(currentSlot),
      nextProposerIndex: blockchain.validatorSet.getIndexForSlot(currentSlot + 1),
    };
  }

  function getValidators() {
    try {
      const keysDir = path.join(__dirname, '../keys');
      return fs
        .readdirSync(keysDir)
        .filter((f) => f.startsWith('validator-') && f.endsWith('.json'))
        .map((f) => {
          const content = JSON.parse(fs.readFileSync(path.join(keysDir, f), 'utf-8'));
          const { encryptedPrivateKey, ...publicData } = content; // never expose the key blob
          return publicData;
        });
    } catch (error) {
      console.error('[api] Error reading validator files:', error);
      throw new ApiError('Internal Server Error', 500);
    }
  }

  const snapshots: Record<Topic, () => any> = {
    status: getStatus,
    blocks: () => blockchain.chain,
    pending: () => blockchain.pendingTransactions,
    peers: () => p2p.getPeerInfo(),
  };

  // --- push helpers ---------------------------------------------------------

  function sendJson(ws: WebSocket, obj: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function publish(topic: Topic) {
    let payload: string | null = null; // serialize once, only if someone listens
    for (const [ws, topics] of subscriptions) {
      if (!topics.has(topic) || ws.readyState !== WebSocket.OPEN) continue;
      payload ??= JSON.stringify({ event: topic, data: snapshots[topic]() });
      ws.send(payload);
    }
  }

  // Event-driven: chain/mempool changes are pushed the moment they happen.
  blockchain.on('pending', () => {
    publish('pending');
    publish('status');
  });
  blockchain.on('blocks', () => {
    publish('blocks');
    publish('pending'); // mempool is pruned when blocks land
    publish('status');
  });

  // Time-driven: slot info always moves; peers have no event hook, so only
  // push them when the snapshot actually changed.
  let lastPeersJson = '';
  setInterval(() => {
    publish('status');
    const json = JSON.stringify(p2p.getPeerInfo());
    if (json !== lastPeersJson) {
      lastPeersJson = json;
      publish('peers');
    }
  }, STATUS_PUSH_INTERVAL_MS);

  // --- methods --------------------------------------------------------------

  const handlers: Record<string, (params: any, ws: WebSocket) => any> = {
    getStatus: () => getStatus(),
    getBlocks: () => blockchain.chain,
    getPending: () => blockchain.pendingTransactions,
    getValidators: () => getValidators(),
    getPeers: () => p2p.getPeerInfo(),

    getAccount: ({ address }) => {
      if (typeof address !== 'string' || !address) throw new ApiError('address is required');
      return blockchain.getAccount(address);
    },

    // Accepts a fully SIGNED transaction.
    submitTransaction: ({ transaction }) => {
      const b = transaction ?? {};
      // Copy only the known fields so nothing extra gets gossiped or stored.
      const tx: Transaction = {
        from: b.from,
        to: b.to,
        amount: b.amount,
        nonce: b.nonce,
        timestamp: b.timestamp,
        publicKey: b.publicKey,
        signature: b.signature,
        hash: b.hash,
      };
      const result = blockchain.addTransaction(tx);
      if (!result.added) throw new ApiError(result.reason ?? 'transaction rejected', 400);
      p2p.broadcastTransaction(tx);
      return { success: true, transaction: tx };
    },

    // Manually trigger this node to propose the next block, if it's its turn.
    propose: () => {
      if (!myValidatorKeys) {
        throw new ApiError('This node has no validator keys configured (VALIDATOR_INDEX not set)', 400);
      }

      const now = Date.now();
      const waitRemaining = blockchain.getSlotWaitRemaining(now);
      if (waitRemaining > 0) {
        throw new ApiError(
          `Must wait ${blockchain.slotWaitMs}ms within the slot before proposing. ${waitRemaining}ms remaining.`,
          429,
          { timeIntoSlot: blockchain.getTimeIntoSlot(now) }
        );
      }

      const latest = blockchain.getLatestBlock();
      const nextIndex = latest.index + 1;
      const currentSlot = blockchain.getSlot(now);

      if (currentSlot <= blockchain.getSlot(latest.timestamp)) {
        throw new ApiError(
          'The current time slot has already been used by an earlier block — wait for the next slot',
          409,
          { currentSlot }
        );
      }

      if (blockchain.validatorSet.getValidatorForSlot(currentSlot) !== myValidatorKeys.publicKey) {
        throw new ApiError("It is not this node's turn to propose in the current time slot", 409, {
          nextIndex,
          currentSlot,
        });
      }

      const transactions = blockchain.selectTransactionsForBlock();
      if (transactions.length === 0) throw new ApiError('No valid pending transactions to include', 400);

      const block = Block.proposeBlock(
        {
          index: nextIndex,
          timestamp: now,
          transactions,
          previousHash: latest.hash,
          validatorPublicKey: myValidatorKeys.publicKey,
        },
        myValidatorKeys.privateKey
      );

      const result = blockchain.addBlock(block);
      if (!result.success) throw new ApiError(result.reason ?? 'block rejected', 500);

      p2p.broadcastNewBlock(block);
      return { success: true, block };
    },

    subscribe: ({ topics }, ws) => {
      const requested = parseTopics(topics);
      const set = subscriptions.get(ws)!;
      requested.forEach((t) => set.add(t));
      // Send current state right after the response goes out.
      setImmediate(() => {
        for (const t of requested) sendJson(ws, { event: t, data: snapshots[t]() });
      });
      return { subscribed: [...set] };
    },

    unsubscribe: ({ topics }, ws) => {
      const set = subscriptions.get(ws)!;
      parseTopics(topics).forEach((t) => set.delete(t));
      return { subscribed: [...set] };
    },
  };

  function parseTopics(input: unknown): Topic[] {
    if (!Array.isArray(input)) throw new ApiError('topics must be an array');
    const bad = input.filter((t) => !TOPICS.includes(t as Topic));
    if (bad.length) throw new ApiError(`unknown topic(s): ${bad.join(', ')}`);
    return input as Topic[];
  }

  // --- connections ------------------------------------------------------------

  wss.on('connection', (ws) => {
    subscriptions.set(ws, new Set());
    alive.set(ws, true);

    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', () => {}); // must have a listener or an error would crash the process
    ws.on('close', () => subscriptions.delete(ws));

    ws.on('message', (raw: RawData) => {
      let req: any;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return sendJson(ws, { error: { message: 'invalid JSON', code: 400 } });
      }
      if (!req || typeof req !== 'object') {
        return sendJson(ws, { error: { message: 'request must be an object', code: 400 } });
      }

      const { id, method, params } = req;
      try {
        const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
        if (!handler) throw new ApiError(`unknown method "${method}"`, 404);
        const result = handler(params ?? {}, ws);
        sendJson(ws, { id, result: result ?? null });
      } catch (err) {
        if (err instanceof ApiError) {
          sendJson(ws, { id, error: { message: err.message, code: err.code, data: err.data } });
        } else {
          console.error('[api] Unexpected error:', err);
          sendJson(ws, { id, error: { message: 'Internal Server Error', code: 500 } });
        }
      }
    });
  });

  // Drop clients that stopped answering pings (half-open sockets).
  setInterval(() => {
    for (const ws of subscriptions.keys()) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('listening', () => console.log(`[api] WebSocket API listening on ws://localhost:${apiPort}`));
}