import { Block } from './block';
import { ValidatorSet } from './validatorSet';
import { Transaction } from './types';
import { loadSnapshot, saveSnapshot } from './storage';

export class Blockchain {
  chain: Block[];
  validatorSet: ValidatorSet;
  pendingTransactions: Transaction[] = [];
  private dataFile?: string;

  // Fixed width of a time slot in ms. Slot ownership cycles through the
  // validator set based purely on wall-clock time (see
  // ValidatorSet.getValidatorForSlot) — this value MUST be identical on
  // every node, or nodes will compute different slot numbers for the same
  // moment and reject each other's blocks.
  slotDurationMs: number;

  constructor(validatorSet: ValidatorSet, dataFile?: string, slotDurationMs = 15000) {
    this.validatorSet = validatorSet;
    this.dataFile = dataFile;
    this.slotDurationMs = slotDurationMs;

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

  /** Returns false (no-op) if this transaction is already pending. */
  addTransaction(tx: Transaction): boolean {
    const key = this.txKey(tx);
    const alreadyPending = this.pendingTransactions.some((t) => this.txKey(t) === key);
    if (alreadyPending) return false;

    this.pendingTransactions.push(tx);
    this.persist();
    return true;
  }

  private txKey(tx: Transaction): string {
    return `${tx.from}-${tx.to}-${tx.amount}-${tx.timestamp}`;
  }



  /**
   * The core validation rules for PoA. A block is only valid if:
   *  1. It correctly extends the previous block (index + previousHash line up)
   *  2. Its hash actually matches its content (no tampering)
   *  3. It's signed by a validator, and that signature is valid
   *  4. It's signed by the SPECIFIC validator who owns the current time slot
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

    // Slots are fixed-width time buckets measured from a shared, fixed
    // origin (see ValidatorSet.getValidatorForSlot) — not from the
    // previous block — so a slot's owner never depends on whether any
    // earlier slot was actually used. Each slot can only be claimed once;
    // a block must land in a strictly later slot than the one before it.
    const slotMs = this.slotDurationMs;
    const blockSlot = Math.floor(block.timestamp / slotMs);
    const previousSlot = Math.floor(previousBlock.timestamp / slotMs);
    if (blockSlot <= previousSlot) {
      return { valid: false, reason: 'block timestamp falls in an already-used or past time slot' };
    }
    const expectedValidator = this.validatorSet.getValidatorForSlot(blockSlot);
    if (block.validatorPublicKey !== expectedValidator) {
      return { valid: false, reason: 'block was not signed by the validator assigned to this time slot' };
    }

    return { valid: true };
  }


  addBlock(rawBlock: any): { success: boolean; reason?: string; alreadyHave?: boolean } {
    const block = rawBlock instanceof Block ? rawBlock : Block.fromPlain(rawBlock);
    const latest = this.getLatestBlock();

    // Duplicate delivery from mesh flooding — not an error, just skip.
    if (block.index <= latest.index) {
      return { success: false, reason: 'already have this block or an equal/later one', alreadyHave: true };
    }

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