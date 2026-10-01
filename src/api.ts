import express from 'express';
import { Blockchain } from './blockchain';
import { P2PNode } from './p2p';
import { Block } from './block';
import { Transaction } from './types';
import { KeyPair } from './crypto';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

export function startApi(
  blockchain: Blockchain,
  p2p: P2PNode,
  apiPort: number,
  myValidatorKeys: KeyPair | null
) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Create an explicit HTTP Server to share ports between Express and WebSockets
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  // Optional: Keep your existing app.get/app.post routes here for backwards compatibility

  // Global handler for WebSocket connections
  wss.on('connection', (ws: WebSocket) => {
    console.log('[ws] Client connected');

    ws.on('message', (message: string) => {
      try {
        const { id, action, payload } = JSON.parse(message);

        // Core RPC Router wrapping your existing logic
        switch (action) {
          case '/blocks':
            return ws.send(JSON.stringify({ id, status: 200, data: blockchain.chain }));

          case '/validators':
            try {
              const keysDir = path.join(__dirname, '../keys');
              const files = fs.readdirSync(keysDir);
              const validatorFiles = files.filter(f => f.startsWith('validator-') && f.endsWith('.json'));
              const validatorsResponse = validatorFiles.map(file => {
                const { encryptedPrivateKey, ...publicValidatorData } = JSON.parse(fs.readFileSync(path.join(keysDir, file), 'utf-8'));
                return publicValidatorData;
              });
              ws.send(JSON.stringify({ id, status: 200, data: validatorsResponse }));
            } catch (err) {
              ws.send(JSON.stringify({ id, status: 500, data: { error: 'Internal Server Error' } }));
            }
            break;

          case '/pending':
            return ws.send(JSON.stringify({ id, status: 200, data: blockchain.pendingTransactions }));

          case '/peers':
            return ws.send(JSON.stringify({ id, status: 200, data: p2p.getPeerInfo() }));

          case '/accounts':
            return ws.send(JSON.stringify({ id, status: 200, data: blockchain.getAccount(payload.address) }));

          case '/status':
            const latest = blockchain.getLatestBlock();
            const now = Date.now();
            const currentSlot = blockchain.getSlot(now);
            return ws.send(JSON.stringify({
              id, status: 200, data: {
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
              }
            }));

          case '/transactions':
            const b = payload ?? {};
            const tx: Transaction = {
              from: b.from, to: b.to, amount: b.amount, nonce: b.nonce,
              timestamp: b.timestamp, publicKey: b.publicKey, signature: b.signature, hash: b.hash,
            };
            const txResult = blockchain.addTransaction(tx);
            if (!txResult.added) {
              return ws.send(JSON.stringify({ id, status: 400, data: { error: txResult.reason } }));
            }
            p2p.broadcastTransaction(tx);
            
            // Broadcast live update to all listeners
            broadcastToAll({ event: 'new_transaction', data: tx });
            return ws.send(JSON.stringify({ id, status: 200, data: { success: true, transaction: tx } }));

          case '/propose':
            if (!myValidatorKeys) {
              return ws.send(JSON.stringify({ id, status: 400, data: { error: 'This node has no validator keys configured' } }));
            }
            const propNow = Date.now();
            const waitRemaining = blockchain.getSlotWaitRemaining(propNow);
            if (waitRemaining > 0) {
              return ws.send(JSON.stringify({ id, status: 429, data: { error: `Must wait...`, timeIntoSlot: blockchain.getTimeIntoSlot(propNow) } }));
            }
            const propLatest = blockchain.getLatestBlock();
            const nextIndex = propLatest.index + 1;
            const propSlot = blockchain.getSlot(propNow);

            if (propSlot <= blockchain.getSlot(propLatest.timestamp)) {
              return ws.send(JSON.stringify({ id, status: 409, data: { error: 'The current time slot has already been used' } }));
            }
            if (blockchain.validatorSet.getValidatorForSlot(propSlot) !== myValidatorKeys.publicKey) {
              return ws.send(JSON.stringify({ id, status: 409, data: { error: "It is not this node's turn" } }));
            }
            const transactions = blockchain.selectTransactionsForBlock();
            if (transactions.length === 0) {
              return ws.send(JSON.stringify({ id, status: 400, data: { error: 'No valid pending transactions' } }));
            }

            const block = Block.proposeBlock({
              index: nextIndex, timestamp: propNow, transactions, previousHash: propLatest.hash, validatorPublicKey: myValidatorKeys.publicKey,
            }, myValidatorKeys.privateKey);

            const blockResult = blockchain.addBlock(block);
            if (!blockResult.success) {
              return ws.send(JSON.stringify({ id, status: 500, data: { error: blockResult.reason } }));
            }

            p2p.broadcastNewBlock(block);
            
            // Broadcast live update to all listeners
            broadcastToAll({ event: 'new_block', data: block });
            return ws.send(JSON.stringify({ id, status: 200, data: { success: true, block } }));

          default:
            ws.send(JSON.stringify({ id, status: 404, data: { error: 'Action not found' } }));
        }
      } catch (err) {
        console.error('[ws] Failed processing message', err);
      }
    });
  });

  // Helper function to broadcast new block emissions out dynamically
  function broadcastToAll(messageObj: any) {
    const raw = JSON.stringify(messageObj);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    });
  }

  // Start the underlying HTTP + WS bundle server
  server.listen(apiPort, () => {
    console.log(`[api/ws] Combined server listening on http/ws://localhost:${apiPort}`);
  });
}
