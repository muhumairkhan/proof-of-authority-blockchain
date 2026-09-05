import express from 'express';
import { Blockchain } from './blockchain';
import { P2PNode } from './p2p';
import { Block } from './block';
import { Transaction } from './types';
import { KeyPair } from './crypto';

export function startApi(
  blockchain: Blockchain,
  p2p: P2PNode,
  apiPort: number,
  myValidatorKeys: KeyPair | null
) {
  const app = express();
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

  app.get('/status', (_req, res) => {
    const latest = blockchain.getLatestBlock();
    res.json({
      chainLength: blockchain.chain.length,
      latestBlockIndex: latest.index,
      latestBlockHash: latest.hash,
      pendingTransactions: blockchain.pendingTransactions.length,
      isValidator: myValidatorKeys !== null,
    });
  });

  app.post('/transactions', (req, res) => {
    const { from, to, amount } = req.body;
    if (typeof from !== 'string' || typeof to !== 'string' || typeof amount !== 'number') {
      return res.status(400).json({ error: 'Expected { from: string, to: string, amount: number }' });
    }
    const tx: Transaction = { from, to, amount, timestamp: Date.now() };
    blockchain.addTransaction(tx);
    p2p.broadcastTransaction(tx);
    res.json({ success: true, transaction: tx });
  });

  // Manually trigger this node to propose the next block, if it's actually its turn.
  app.post('/propose', (_req, res) => {
    if (!myValidatorKeys) {
      return res.status(400).json({ error: 'This node has no validator keys configured (VALIDATOR_INDEX not set)' });
    }

    const latest = blockchain.getLatestBlock();
    const nextIndex = latest.index + 1;
    const expectedValidator = blockchain.validatorSet.getValidatorForIndex(nextIndex);

    console.log(myValidatorKeys)

    if (expectedValidator !== myValidatorKeys.publicKey) {
      return res.status(409).json({
        error: "It is not this node's turn to propose the next block",
        nextIndex,
      });
    }

    const block = Block.proposeBlock(
      {
        index: nextIndex,
        timestamp: Date.now(),
        transactions: blockchain.pendingTransactions,
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
