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

  // Minimum time a validator must wait after a slot begins before it may
  // propose in it. Part of the consensus rules: MUST be identical on every
  // node, same as slotDurationMs.
  slotWaitMs: number;

  constructor(
    validatorSet: ValidatorSet,
    dataFile?: string,
    slotDurationMs = 15000,
    slotWaitMs = 3000
  ) {
    if (slotWaitMs < 0 || slotWaitMs >= slotDurationMs) {
      throw new Error(
        `slotWaitMs (${slotWaitMs}) must be >= 0 and less than slotDurationMs (${slotDurationMs})`
      );
    }

    this.validatorSet = validatorSet;
    this.dataFile = dataFile;
    this.slotDurationMs = slotDurationMs;
    this.slotWaitMs = slotWaitMs;

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

    /** Slot number that contains the given wall-clock timestamp (ms). */
  getSlot(timestampMs: number): number {
    return Math.floor(timestampMs / this.slotDurationMs);
  }

  /** Wall-clock start (ms) of the slot containing the timestamp. */
  getSlotStart(timestampMs: number): number {
    return this.getSlot(timestampMs) * this.slotDurationMs;
  }

  /** How far into its slot the timestamp falls, in ms. */
  getTimeIntoSlot(timestampMs: number): number {
    return timestampMs - this.getSlotStart(timestampMs);
  }

  /** ms left of the mandatory wait period at this moment (0 if it's over). */
  getSlotWaitRemaining(timestampMs: number): number {
    return Math.max(0, this.slotWaitMs - this.getTimeIntoSlot(timestampMs));
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
    const blockSlot = this.getSlot(block.timestamp);
    const previousSlot = this.getSlot(previousBlock.timestamp);

    if (blockSlot <= previousSlot) {
      return { valid: false, reason: 'block timestamp falls in an already-used or past time slot' };
    }

    // Reject block if it was produced before the mandatory wait time into its slot
    if (this.getTimeIntoSlot(block.timestamp) < this.slotWaitMs) {
      return { valid: false, reason: `block was proposed before the ${this.slotWaitMs}ms slot wait time` };
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

    // Must start at the exact same genesis block as our own chain — not just
    // "any block claiming index 0". A peer could otherwise hand us a chain
    // rooted in a completely different genesis (different transactions,
    // different timestamp, different validator set encoded downstream) and,
    // as long as it's internally consistent from block 1 onward, nothing
    // here would catch it.
    const expectedGenesisHash = Block.createGenesisBlock().hash;
    if (chain[0].index !== 0 || chain[0].hash !== expectedGenesisHash) {
      return false;
    }

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