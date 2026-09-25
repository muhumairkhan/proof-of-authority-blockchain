
import WebSocket, { WebSocketServer } from 'ws';
import { Blockchain } from './blockchain';
import { Transaction } from './types';

type Message =
  | { type: 'CHAIN_REQUEST' }
  | { type: 'CHAIN_RESPONSE'; chain: any[] }
  | { type: 'NEW_BLOCK'; block: any }
  | { type: 'NEW_TRANSACTION'; transaction: Transaction };

// Tag every socket with liveness + (if outbound) the address that owns it,
// so the heartbeat and reconnect logic can find what they need without a
// separate parallel map.
type TrackedSocket = WebSocket & {
  isAlive?: boolean;
  peerAddress?: string; // only set for sockets we dialed out to
};

const HEARTBEAT_INTERVAL_MS = 10_000; // how often we ping every socket
const RECONNECT_BASE_MS = 1_000; // first retry delay
const RECONNECT_MAX_MS = 30_000; // cap on backoff

export class P2PNode {
  private sockets: TrackedSocket[] = [];
  private server?: WebSocketServer;
  private heartbeatTimer?: NodeJS.Timeout;
  // address -> current backoff delay, so repeated failures back off but a
  // fresh success resets it
  private reconnectDelays = new Map<string, number>();

  constructor(private blockchain: Blockchain, private p2pPort: number) {}

  start() {
    this.server = new WebSocketServer({ port: this.p2pPort });
    this.server.on('connection', (socket) => this.registerSocket(socket as TrackedSocket));
    console.log(`[p2p] Listening for peers on ws://localhost:${this.p2pPort}`);

    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  /**
   * Dial out to a peer we're supposed to stay connected to. On any
   * disconnect (error, close, or a failed heartbeat) this will keep
   * retrying with exponential backoff until it succeeds — that's what
   * makes a node coming back up get rediscovered.
   */
  connectToPeer(address: string) {
    const socket = new WebSocket(address) as TrackedSocket;
    socket.peerAddress = address;

    socket.on('open', () => {
      this.reconnectDelays.set(address, RECONNECT_BASE_MS); // reset backoff on success
      this.registerSocket(socket);
      console.log(`[p2p] Connected to peer ${address}`);
    });

    socket.on('error', (err: Error) => {
      // 'close' fires after 'error' for a failed connection attempt too,
      // so just log here — the retry itself is scheduled from 'close'.
      console.error(`[p2p] Could not connect to ${address}: ${err.message}`);
    });

    socket.on('close', () => {
      this.scheduleReconnect(address);
    });
  }

  private scheduleReconnect(address: string) {
    const delay = this.reconnectDelays.get(address) ?? RECONNECT_BASE_MS;
    console.log(`[p2p] Lost connection to ${address}, retrying in ${delay}ms`);

    setTimeout(() => this.connectToPeer(address), delay);

    // back off for next time, capped
    this.reconnectDelays.set(address, Math.min(delay * 2, RECONNECT_MAX_MS));
  }

  private runHeartbeat() {
    for (const socket of this.sockets) {
      if (socket.isAlive === false) {
        // Didn't respond to the last ping — treat as dead. terminate()
        // forces the close (unlike close(), it doesn't wait for a
        // handshake that a half-open socket will never complete), which
        // fires 'close' and — for outbound sockets — triggers reconnect.
        console.log(`[p2p] Peer unresponsive, terminating${socket.peerAddress ? ` (${socket.peerAddress})` : ''}`);
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }

  private registerSocket(socket: TrackedSocket) {
    this.sockets.push(socket);
    socket.isAlive = true;

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (raw: Buffer) => {
      let message: Message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed messages
      }
      this.handleMessage(socket, message);
    });

    socket.on('close', () => {
      this.sockets = this.sockets.filter((s) => s !== socket);
    });

    // Sync immediately on connect: ask the peer what chain it has.
    this.send(socket, { type: 'CHAIN_REQUEST' });
  }

  private handleMessage(socket: WebSocket, message: Message) {
    switch (message.type) {
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
      if (socket !== exclude && socket.readyState === WebSocket.OPEN) {
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