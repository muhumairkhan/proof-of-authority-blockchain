import { Block } from './block';
import { ValidatorSet } from './validatorSet';
import { Transaction } from './types';

export class Blockchain {
  chain: Block[];
  validatorSet: ValidatorSet;
  pendingTransactions: Transaction[] = [];

  constructor(validatorSet: ValidatorSet) {
    this.chain = [Block.createGenesisBlock()];
    this.validatorSet = validatorSet;
  }

  getLatestBlock(): Block {
    return this.chain[this.chain.length - 1];
  }

  addTransaction(tx: Transaction) {
    this.pendingTransactions.push(tx);
  }

  /**
   * The core validation rules for PoA. A block is only valid if:
   *  1. It correctly extends the previous block (index + previousHash line up)
   *  2. Its hash actually matches its content (no tampering)
   *  3. It's signed by a validator, and that signature is valid
   *  4. It's signed by the SPECIFIC validator whose turn it is for this index
   */
  isValidNewBlock(block: Block, previousBlock: Block): { valid: boolean; reason?: string } {
    if (block.index !== previousBlock.index + 1) {
      return { valid: false, reason: `Bad index: expected ${previousBlock.index + 1}, got ${block.index}` };
    }
    if (block.previousHash !== previousBlock.hash) {
      return { valid: false, reason: 'previousHash does not match previous block' };
    }
    if (!block.isHashValid()) {
      return { valid: false, reason: 'hash does not match block content (tampering?)' };
    }
    if (!block.isSignatureValid()) {
      return { valid: false, reason: 'invalid validator signature' };
    }
    const expectedValidator = this.validatorSet.getValidatorForIndex(block.index);
    if (block.validatorPublicKey !== expectedValidator) {
      return { valid: false, reason: "block was not signed by the validator whose turn it is" };
    }
    return { valid: true };
  }

  /** Accepts a block (plain object from network, or a real Block instance). */
  addBlock(rawBlock: any): { success: boolean; reason?: string } {
    const block = rawBlock instanceof Block ? rawBlock : Block.fromPlain(rawBlock);
    const latest = this.getLatestBlock();
    const check = this.isValidNewBlock(block, latest);
    if (!check.valid) return { success: false, reason: check.reason };

    this.chain.push(block);

    // Remove any pending transactions that made it into this block.
    const includedKeys = new Set(
      block.transactions.map((t) => `${t.from}-${t.to}-${t.amount}-${t.timestamp}`)
    );
    this.pendingTransactions = this.pendingTransactions.filter(
      (t) => !includedKeys.has(`${t.from}-${t.to}-${t.amount}-${t.timestamp}`)
    );

    return { success: true };
  }

  /** Validates an entire candidate chain (e.g. one received from a peer). */
  isChainValid(rawChain: any[]): boolean {
    if (!Array.isArray(rawChain) || rawChain.length === 0) return false;

    const chain = rawChain.map((b) => Block.fromPlain(b));
    if (chain[0].index !== 0) return false; // must start at genesis

    for (let i = 1; i < chain.length; i++) {
      const check = this.isValidNewBlock(chain[i], chain[i - 1]);
      if (!check.valid) return false;
    }
    return true;
  }

  /**
   * Longest-valid-chain rule: only replace our chain if the candidate is
   * both longer AND fully valid under our consensus rules.
   */
  replaceChain(rawChain: any[]): { replaced: boolean; reason?: string } {
    if (!Array.isArray(rawChain) || rawChain.length <= this.chain.length) {
      return { replaced: false, reason: 'received chain is not longer than current chain' };
    }
    if (!this.isChainValid(rawChain)) {
      return { replaced: false, reason: 'received chain failed validation' };
    }
    this.chain = rawChain.map((b) => Block.fromPlain(b));
    return { replaced: true };
  }
}
