import express from 'express';
import { Blockchain } from './blockchain';
import { P2PNode } from './p2p';
import { Block } from './block';
import { Transaction } from './types';
import { KeyPair } from './crypto';
import cors from 'cors';

export function startApi(
  blockchain: Blockchain,
  p2p: P2PNode,
  apiPort: number,
  myValidatorKeys: KeyPair | null
) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/blocks', (_req, res) => {
    res.json(blockchain.chain);
  });

  app.get('/validators', (_req, res) => {
    res.json(blockchain.validatorSet.getAll());
  });

  app.get('/pending', (_req, res) => {
    res.json(blockchain.pendingTransactions);
  });

  app.get('/accounts/:address', (req, res) => {
    res.json(blockchain.getAccount(req.params.address));
  });

  app.get('/status', (_req, res) => {
    const latest = blockchain.getLatestBlock();
    const now = Date.now();
    const currentSlot = blockchain.getSlot(now);

    res.json({
      chainLength: blockchain.chain.length,
      latestBlockIndex: latest.index,
      latestBlockHash: latest.hash,
      latestBlockTimestamp: latest.timestamp,
      pendingTransactions: blockchain.pendingTransactions.length,
      isValidator: myValidatorKeys !== null,

      // slot info for the UI
      serverTime: now,
      slotDurationMs: blockchain.slotDurationMs,
      slotWaitMs: blockchain.slotWaitMs,
      currentSlot,
      currentProposerIndex: blockchain.validatorSet.getIndexForSlot(currentSlot),
      nextProposerIndex: blockchain.validatorSet.getIndexForSlot(currentSlot + 1),
    });
  });

  // Accepts a fully SIGNED transaction (build one with `npm run wallet -- send ...`).
  app.post('/transactions', (req, res) => {
    const b = req.body ?? {};
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
    if (!result.added) {
      return res.status(400).json({ error: result.reason });
    }
    p2p.broadcastTransaction(tx);
    res.json({ success: true, transaction: tx });
  });

  // Manually trigger this node to propose the next block, if it's actually its turn.
  app.post('/propose', (_req, res) => {
    if (!myValidatorKeys) {
      return res.status(400).json({ error: 'This node has no validator keys configured (VALIDATOR_INDEX not set)' });
    }

    const now = Date.now();

    const waitRemaining = blockchain.getSlotWaitRemaining(now);
    if (waitRemaining > 0) {
      return res.status(429).json({
        error: `Must wait ${blockchain.slotWaitMs}ms within the slot before proposing. ${waitRemaining}ms remaining.`,
        timeIntoSlot: blockchain.getTimeIntoSlot(now),
      });
    }

    const latest = blockchain.getLatestBlock();
    const nextIndex = latest.index + 1;
    const currentSlot = blockchain.getSlot(now);

    if (currentSlot <= blockchain.getSlot(latest.timestamp)) {
      return res.status(409).json({
        error: 'The current time slot has already been used by an earlier block — wait for the next slot',
        currentSlot,
      });
    }

    const expectedValidator = blockchain.validatorSet.getValidatorForSlot(currentSlot);

    if (expectedValidator !== myValidatorKeys.publicKey) {
      return res.status(409).json({
        error: "It is not this node's turn to propose in the current time slot",
        nextIndex,
        currentSlot,
      });
    }

    const transactions = blockchain.selectTransactionsForBlock();
    if (transactions.length === 0) {
      return res.status(400).json({ error: 'No valid pending transactions to include' });
    }

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
    if (!result.success) {
      return res.status(500).json({ error: result.reason });
    }

    p2p.broadcastNewBlock(block);
    res.json({ success: true, block });
  });

  app.listen(apiPort, () => {
    console.log(`[api] Listening on http://localhost:${apiPort}`);
  });
}