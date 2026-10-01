import WebSocket, { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import { IncomingMessage } from 'http';
import { Blockchain } from './blockchain';
import { Transaction } from './types';
import { PeerTable, normalizeAddress, addressFromRemote } from './peerTable';

type Message =
  | { type: 'HELLO'; nodeId: string; p2pPort: number; genesisHash: string; slotDurationMs: number; slotWaitMs: number }
  | { type: 'GET_PEERS' }
  | { type: 'PEERS'; addresses: string[] }
  | { type: 'CHAIN_REQUEST' }
  | { type: 'CHAIN_RESPONSE'; chain: any[] }
  | { type: 'NEW_BLOCK'; block: any }
  | { type: 'NEW_TRANSACTION'; transaction: Transaction };

// Per-socket state. A socket is "handshaken" once both sides have exchanged
// a compatible HELLO; until then every non-HELLO message is ignored.
type TrackedSocket = WebSocket & {
  isAlive?: boolean;
  dialAddress?: string; // set only for sockets WE dialed
  remoteIp?: string; // set only for inbound sockets
  remoteNodeId?: string;
  announcedAddress?: string; // the dialable address of the peer on the other end
  handshaken?: boolean;
  handshakeTimer?: NodeJS.Timeout;
  expectedClose?: boolean; // we closed it on purpose (duplicate / self / incompatible): no failure penalty
};

const HEARTBEAT_INTERVAL_MS = 10_000; // how often we ping every socket
const MAINTAIN_INTERVAL_MS = 2_000; // how often we look for peers we should (re)dial
const PEER_EXCHANGE_INTERVAL_MS = 30_000; // periodic GET_PEERS to every connected peer
const HANDSHAKE_TIMEOUT_MS = 5_000; // drop sockets that never send a valid HELLO
const RECONNECT_BASE_MS = 1_000; // first retry delay
const RECONNECT_MAX_MS = 30_000; // cap on backoff
const MAX_PEERS_PER_MESSAGE = 50;

export class P2PNode {
  /** Random per process start. Lets two nodes notice self-dials and duplicate connections. */
  readonly nodeId = randomBytes(8).toString('hex');

  private sockets: TrackedSocket[] = [];
  private server?: WebSocketServer;
  private timers: NodeJS.Timeout[] = [];
  private dialing = new Set<string>(); // addresses with a dial in flight (or a live outbound socket)
  private nextAttempt = new Map<string, number>(); // address -> earliest time we may dial again

  constructor(
    private blockchain: Blockchain,
    private p2pPort: number,
    private peers: PeerTable
  ) {
    // Never dial ourselves.
    const self = normalizeAddress(`ws://localhost:${p2pPort}`);
    if (self) this.peers.block(self);
  }

  start() {
    this.server = new WebSocketServer({ port: this.p2pPort });
    this.server.on('connection', (socket, req: IncomingMessage) => {
      const s = socket as TrackedSocket;
      s.remoteIp = req.socket.remoteAddress;
      this.registerSocket(s);
    });
    console.log(`[p2p] Listening for peers on ws://localhost:${this.p2pPort} (node ${this.nodeId.slice(0, 6)})`);

    this.timers.push(setInterval(() => this.runHeartbeat(), HEARTBEAT_INTERVAL_MS));
    this.timers.push(setInterval(() => this.maintainConnections(), MAINTAIN_INTERVAL_MS));
    this.timers.push(setInterval(() => this.requestPeers(), PEER_EXCHANGE_INTERVAL_MS));
    this.maintainConnections();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of this.sockets) {
      s.expectedClose = true;
      s.terminate();
    }
    this.server?.close();
  }

  /** Snapshot for the /peers API endpoint. */
  getPeerInfo() {
    return {
      nodeId: this.nodeId,
      p2pPort: this.p2pPort,
      connected: this.sockets
        .filter((s) => s.handshaken && s.readyState === WebSocket.OPEN)
        .map((s) => ({
          address: s.announcedAddress,
          nodeId: s.remoteNodeId,
          direction: s.dialAddress ? 'outbound' : 'inbound',
        })),
      known: this.peers.all(),
    };
  }

  // ---------------------------------------------------------------------------
  // Dialing: one loop decides who we should be connected to
  // ---------------------------------------------------------------------------

  /**
   * Walks the peer table and dials anything that isn't connected and isn't
   * in backoff. This replaces per-socket reconnect timers, so a node that
   * comes back up (or a freshly learned address) is picked up within a tick,
   * and a connection that was closed as a duplicate is never re-dialed.
   *
   * Unverified addresses are dialed even if an inbound connection from them
   * exists — that dial IS the dial-back that proves the address is real.
   */
  private maintainConnections() {
    const now = Date.now();
    for (const entry of this.peers.all()) {
      const address = entry.address;
      if (this.dialing.has(address)) continue;
      if ((this.nextAttempt.get(address) ?? 0) > now) continue;
      if (entry.lastSeen > 0 && this.isConnected(address)) continue;
      this.dial(address);
    }
  }

  private isConnected(address: string): boolean {
    return this.sockets.some(
      (s) => s.handshaken && s.announcedAddress === address && s.readyState === WebSocket.OPEN
    );
  }

  private dial(address: string) {
    this.dialing.add(address);

    let socket: TrackedSocket;
    try {
      socket = new WebSocket(address, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS }) as TrackedSocket;
    } catch (err) {
      this.dialing.delete(address);
      this.onDialFailed(address);
      return;
    }
    socket.dialAddress = address;

    socket.on('open', () => this.registerSocket(socket));

    socket.on('error', (err: Error) => {
      // 'close' always follows 'error' for a failed attempt; the failure is counted there.
      console.error(`[p2p] Could not connect to ${address}: ${err.message}`);
    });

    socket.on('close', () => {
      this.dialing.delete(address);
      if (!socket.handshaken && !socket.expectedClose) this.onDialFailed(address);
    });
  }

  private onDialFailed(address: string) {
    const { dropped } = this.peers.recordFailure(address);
    if (dropped) {
      this.nextAttempt.delete(address);
      console.log(`[p2p] Dropped unreachable peer ${address}`);
      return;
    }
    const failures = this.peers.get(address)?.failures ?? 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (failures - 1), RECONNECT_MAX_MS);
    this.nextAttempt.set(address, Date.now() + delay);
    console.log(`[p2p] Cannot reach ${address} (failure ${failures}), retrying in ${delay}ms`);
  }

  // ---------------------------------------------------------------------------
  // Heartbeat / periodic exchange
  // ---------------------------------------------------------------------------

  private runHeartbeat() {
    for (const socket of this.sockets) {
      if (socket.isAlive === false) {
        // Didn't respond to the last ping — treat as dead. terminate() forces
        // the close (a half-open socket would never finish a close handshake);
        // maintainConnections() then redials it if it's a peer we should have.
        console.log(`[p2p] Peer unresponsive, terminating${socket.announcedAddress ? ` (${socket.announcedAddress})` : ''}`);
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }

  private requestPeers() {
    for (const socket of this.sockets) {
      if (socket.handshaken) this.send(socket, { type: 'GET_PEERS' });
    }
  }

  // ---------------------------------------------------------------------------
  // Socket lifecycle + handshake
  // ---------------------------------------------------------------------------

  private hello(): Message {
    return {
      type: 'HELLO',
      nodeId: this.nodeId,
      p2pPort: this.p2pPort,
      genesisHash: this.blockchain.chain[0].hash,
      slotDurationMs: this.blockchain.slotDurationMs,
      slotWaitMs: this.blockchain.slotWaitMs,
    };
  }

  private registerSocket(socket: TrackedSocket) {
    this.sockets.push(socket);
    socket.isAlive = true;

    socket.handshakeTimer = setTimeout(() => {
      if (!socket.handshaken) {
        console.log(`[p2p] No valid HELLO within ${HANDSHAKE_TIMEOUT_MS}ms, dropping socket`);
        socket.terminate();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('error', (err: Error) => {
      // Must have a listener or an unhandled 'error' event would crash the process.
      console.debug(`[p2p] Socket error: ${err.message}`);
    });

    socket.on('message', (raw: Buffer) => {
      let message: Message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed messages
      }
      if (!message || typeof message !== 'object') return;

      if (message.type === 'HELLO') {
        this.handleHello(socket, message);
      } else if (socket.handshaken) {
        this.handleMessage(socket, message);
      }
      // anything else before the handshake completes is ignored
    });

    socket.on('close', () => {
      if (socket.handshakeTimer) clearTimeout(socket.handshakeTimer);
      this.sockets = this.sockets.filter((s) => s !== socket);
      // A live connection dropped: allow a quick redial (no penalty, it was healthy).
      if (socket.handshaken && socket.announcedAddress && !socket.expectedClose) {
        this.nextAttempt.set(socket.announcedAddress, Date.now() + RECONNECT_BASE_MS);
        console.log(`[p2p] Lost connection to ${socket.announcedAddress}`);
      }
    });

    this.send(socket, this.hello());
  }

  private reject(socket: TrackedSocket, why: string) {
    console.log(`[p2p] Rejecting peer${socket.dialAddress ? ` ${socket.dialAddress}` : ''}: ${why}`);
    socket.expectedClose = true;
    socket.terminate();
  }

  private handleHello(socket: TrackedSocket, m: any) {
    if (socket.handshaken) return;

    const valid =
      typeof m.nodeId === 'string' && m.nodeId.length > 0 &&
      Number.isInteger(m.p2pPort) && m.p2pPort >= 1 && m.p2pPort <= 65535 &&
      typeof m.genesisHash === 'string' &&
      Number.isFinite(m.slotDurationMs) && Number.isFinite(m.slotWaitMs);
    if (!valid) return this.reject(socket, 'malformed HELLO');

    // We dialed ourselves (e.g. via a bootnode list or gossip).
    if (m.nodeId === this.nodeId) {
      if (socket.dialAddress) this.peers.block(socket.dialAddress);
      return this.reject(socket, 'that is this node');
    }

    // Incompatible network: wrong genesis, or different slot parameters
    // (which would make us disagree on slot ownership and reject each other's blocks).
    const genesisHash = this.blockchain.chain[0].hash;
    if (
      m.genesisHash !== genesisHash ||
      m.slotDurationMs !== this.blockchain.slotDurationMs ||
      m.slotWaitMs !== this.blockchain.slotWaitMs
    ) {
      if (socket.dialAddress) this.peers.block(socket.dialAddress);
      return this.reject(socket, 'incompatible genesis or slot parameters');
    }

    // Where can this peer be dialed? For sockets we dialed, the address we used.
    // For inbound sockets: the remote IP plus the port it announced.
    const announced = socket.dialAddress ?? addressFromRemote(socket.remoteIp, m.p2pPort);
    if (!announced) return this.reject(socket, 'cannot determine peer address');
    if (this.peers.isBlocked(announced)) return this.reject(socket, 'blocked address');

    socket.remoteNodeId = m.nodeId;
    socket.announcedAddress = announced;

    // Two nodes often dial each other at the same moment. Keep exactly one
    // connection per node: the one initiated by the node with the lower ID.
    // Both sides apply the same rule, so they close the same socket.
    const existing = this.sockets.find(
      (s) => s !== socket && s.handshaken && !s.expectedClose && s.remoteNodeId === m.nodeId
    );
    if (existing) {
      if (!this.shouldReplace(existing, socket)) {
        // The address we just dialed did answer with a valid HELLO, so it IS verified.
        if (socket.dialAddress) this.peers.recordSuccess(socket.dialAddress);
        socket.expectedClose = true;
        socket.terminate();
        return;
      }
      existing.expectedClose = true;
      existing.terminate();
    }

    socket.handshaken = true;
    if (socket.handshakeTimer) clearTimeout(socket.handshakeTimer);

    if (socket.dialAddress) {
      // Outbound handshake succeeded: this address is now verified.
      const firstTime = this.peers.recordSuccess(socket.dialAddress);
      this.nextAttempt.delete(socket.dialAddress);
      console.log(`[p2p] Connected to peer ${announced} (node ${m.nodeId.slice(0, 6)})`);
      // Tell everyone else about a newly verified peer so the mesh fills in quickly.
      if (firstTime) this.broadcast({ type: 'PEERS', addresses: [announced] }, socket);
    } else {
      // Inbound: the announced port is only a claim. Record it as a candidate;
      // maintainConnections() will dial it back, and only that success verifies it.
      this.peers.add(announced);
      console.log(`[p2p] Peer ${announced} connected to us (node ${m.nodeId.slice(0, 6)})`);
      this.maintainConnections();
    }

    // Handshake done: sync the chain and learn who else is out there.
    this.send(socket, { type: 'CHAIN_REQUEST' });
    this.send(socket, { type: 'GET_PEERS' });
  }

  /** True if `incoming` should win over `existing` for the same remote node. */
  private shouldReplace(existing: TrackedSocket, incoming: TrackedSocket): boolean {
    const initiator = (s: TrackedSocket) => (s.dialAddress ? this.nodeId : s.remoteNodeId!);
    const existingInit = initiator(existing);
    const incomingInit = initiator(incoming);
    if (existingInit === incomingInit) return true; // same side dialed twice: keep the newer
    return incomingInit < existingInit; // otherwise the lower initiator ID wins
  }

  // ---------------------------------------------------------------------------
  // Messages (only reached after the handshake)
  // ---------------------------------------------------------------------------

  private handleMessage(socket: TrackedSocket, message: Message) {
    switch (message.type) {
      case 'GET_PEERS': {
        const addresses = this.peers
          .verified()
          .filter((a) => a !== socket.announcedAddress)
          .slice(0, MAX_PEERS_PER_MESSAGE);
        this.send(socket, { type: 'PEERS', addresses });
        break;
      }

      case 'PEERS': {
        if (!Array.isArray(message.addresses)) break;
        let added = false;
        for (const raw of message.addresses.slice(0, MAX_PEERS_PER_MESSAGE)) {
          if (typeof raw !== 'string') continue;
          // Learned from gossip = unverified candidate. We dial it ourselves;
          // we never trust (or re-share) it until our own handshake succeeds.
          if (this.peers.add(raw)) added = true;
        }
        if (added) this.maintainConnections();
        break;
      }

      case 'CHAIN_REQUEST':
        this.send(socket, { type: 'CHAIN_RESPONSE', chain: this.blockchain.chain });
        break;

      case 'CHAIN_RESPONSE': {
        const result = this.blockchain.replaceChain(message.chain);
        if (result.replaced) {
          console.log(`[chain] Replaced local chain (new length ${message.chain.length})`);
        }
        break;
      }

      case 'NEW_BLOCK': {
        const result = this.blockchain.addBlock(message.block);
        if (result.success) {
          const validatorIndex = this.blockchain.validatorSet
            .getAll()
            .indexOf(message.block.validatorPublicKey);

          const proposerLabel = validatorIndex !== -1
            ? `validator #${validatorIndex}`
            : `unknown (${message.block.validatorPublicKey.slice(0, 10)}...)`;

          console.log(`[chain] Accepted new block #${message.block.index} proposed by ${proposerLabel}`);
          this.broadcast({ type: 'NEW_BLOCK', block: message.block }, socket);
        } else if (result.alreadyHave) {
          // Silent no-op — expected under mesh flooding
        } else {
          console.log(`[chain] Rejected block from network (${result.reason}) — requesting full chain`);
          this.send(socket, { type: 'CHAIN_REQUEST' });
        }
        break;
      }

      case 'NEW_TRANSACTION': {
        const result = this.blockchain.addTransaction(message.transaction);
        if (result.added) {
          this.broadcast({ type: 'NEW_TRANSACTION', transaction: message.transaction }, socket);
        }
        break;
      }
    }
  }

  broadcastNewBlock(block: any) {
    this.broadcast({ type: 'NEW_BLOCK', block });
  }

  broadcastTransaction(transaction: Transaction) {
    this.broadcast({ type: 'NEW_TRANSACTION', transaction });
  }

  private broadcast(message: Message, exclude?: WebSocket) {
    const payload = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket !== exclude && socket.handshaken && socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  private send(socket: WebSocket, message: Message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      socket.once('open', () => socket.send(JSON.stringify(message)));
    }
  }
}