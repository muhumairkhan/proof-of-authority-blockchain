import { Block } from './block';
import { ValidatorSet } from './validatorSet';
import { Transaction } from './types';
import { loadSnapshot, saveSnapshot } from './storage';

export class Blockchain {
  chain: Block[];
  validatorSet: ValidatorSet;
  pendingTransactions: Transaction[] = [];
  private dataFile?: string;

  constructor(validatorSet: ValidatorSet, dataFile?: string) {
    this.validatorSet = validatorSet;
    this.dataFile = dataFile;

    const snapshot = dataFile ? loadSnapshot(dataFile) : null;
    if (snapshot) {
      this.chain = snapshot.chain.map((b) => Block.fromPlain(b));
      this.pendingTransactions = snapshot.pendingTransactions;
      console.log(`[storage] Restored ${this.chain.length} blocks (${this.pendingTransactions.length} pending tx) from ${dataFile}`);
    } else {
      this.chain = [Block.createGenesisBlock()];
    }
  }

  private persist() {
    if (!this.dataFile) return;
    saveSnapshot(this.dataFile, { chain: this.chain, pendingTransactions: this.pendingTransactions });
  }

  getLatestBlock(): Block {
    return this.chain[this.chain.length - 1];
  }

  addTransaction(tx: Transaction) {
    this.pendingTransactions.push(tx);
    this.persist();
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


  addBlock(rawBlock: any): { success: boolean; reason?: string } {
    const block = rawBlock instanceof Block ? rawBlock : Block.fromPlain(rawBlock);
    const latest = this.getLatestBlock();
    const check = this.isValidNewBlock(block, latest);
    if (!check.valid) return { success: false, reason: check.reason };

    this.chain.push(block);

    const includedKeys = new Set(
      block.transactions.map((t) => `${t.from}-${t.to}-${t.amount}-${t.timestamp}`)
    );
    this.pendingTransactions = this.pendingTransactions.filter(
      (t) => !includedKeys.has(`${t.from}-${t.to}-${t.amount}-${t.timestamp}`)
    );

    this.persist();
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


  replaceChain(rawChain: any[]): { replaced: boolean; reason?: string } {
    if (!Array.isArray(rawChain) || rawChain.length <= this.chain.length) {
      return { replaced: false, reason: 'received chain is not longer than current chain' };
    }
    if (!this.isChainValid(rawChain)) {
      return { replaced: false, reason: 'received chain failed validation' };
    }
    this.chain = rawChain.map((b) => Block.fromPlain(b));
    this.persist();
    return { replaced: true };
  }
}




  