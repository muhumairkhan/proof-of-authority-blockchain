import WebSocket, { WebSocketServer } from 'ws';
import { Blockchain } from './blockchain';
import { Transaction } from './types';

type Message =
  | { type: 'CHAIN_REQUEST' }
  | { type: 'CHAIN_RESPONSE'; chain: any[] }
  | { type: 'NEW_BLOCK'; block: any }
  | { type: 'NEW_TRANSACTION'; transaction: Transaction };

export class P2PNode {
  private sockets: WebSocket[] = [];
  private server?: WebSocketServer;

  constructor(private blockchain: Blockchain, private p2pPort: number) {}

  start() {
    this.server = new WebSocketServer({ port: this.p2pPort });
    this.server.on('connection', (socket) => this.registerSocket(socket));
    console.log(`[p2p] Listening for peers on ws://localhost:${this.p2pPort}`);
  }

  connectToPeer(address: string) {
    const socket = new WebSocket(address);
    socket.on('open', () => {
      this.registerSocket(socket);
      console.log(`[p2p] Connected to peer ${address}`);
    });
    socket.on('error', (err: Error) => {
      console.error(`[p2p] Could not connect to ${address}: ${err.message}`);
    });
  }

  private registerSocket(socket: WebSocket) {
    this.sockets.push(socket);

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
          console.log(`[chain] Accepted new block #${message.block.index} from network`);
          this.broadcast({ type: 'NEW_BLOCK', block: message.block }, socket);
        } else {
          console.log(`[chain] Rejected block from network (${result.reason}) — requesting full chain`);
          this.send(socket, { type: 'CHAIN_REQUEST' });
        }
        break;
      }

      case 'NEW_TRANSACTION': {
        this.blockchain.addTransaction(message.transaction);
        this.broadcast({ type: 'NEW_TRANSACTION', transaction: message.transaction }, socket);
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
