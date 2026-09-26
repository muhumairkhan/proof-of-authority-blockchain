import { Block } from './block';
import { ValidatorSet } from './validatorSet';
import { Transaction } from './types';
import { loadSnapshot, saveSnapshot } from './storage';
import { WorldState, GenesisAllocations } from './state';
import { verifyTransaction } from './transaction';

type ChainValidation =
  | { ok: true; chain: Block[]; state: WorldState }
  | { ok: false; reason: string };

export class Blockchain {
  chain: Block[];
  validatorSet: ValidatorSet;
  pendingTransactions: Transaction[] = [];
  private dataFile?: string;
  private genesisAllocations: GenesisAllocations;

  // Balances + nonces, derived from the chain. Kept in memory only.
  private state: WorldState;

  // Fixed width of a time slot in ms. Must be identical on every node.
  slotDurationMs: number;

  // Minimum time a validator must wait after a slot begins before it may
  // propose in it. Must be identical on every node.
  slotWaitMs: number;

  constructor(
    validatorSet: ValidatorSet,
    dataFile?: string,
    slotDurationMs = 15000,
    slotWaitMs = 3000,
    genesisAllocations: GenesisAllocations = {}
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
    this.genesisAllocations = genesisAllocations;

    const snapshot = dataFile ? loadSnapshot(dataFile) : null;
    const restored = snapshot ? this.validateChain(snapshot.chain) : null;

    if (snapshot && restored && restored.ok) {
      this.chain = restored.chain;
      this.state = restored.state;
      this.pendingTransactions = snapshot.pendingTransactions;
      console.log(`[storage] Restored ${this.chain.length} blocks (${this.pendingTransactions.length} pending tx) from ${dataFile}`);
    } else {
      if (snapshot && restored && !restored.ok) {
        console.warn(`[storage] Saved chain failed replay (${restored.reason}) — starting from genesis. Run \`npm run reset\` if this is old-format data.`);
      }
      this.chain = [Block.createGenesisBlock()];
      this.state = new WorldState(genesisAllocations);
    }
  }

  private persist() {
    if (!this.dataFile) return;
    saveSnapshot(this.dataFile, { chain: this.chain, pendingTransactions: this.pendingTransactions });
  }

  getLatestBlock(): Block {
    return this.chain[this.chain.length - 1];
  }

  // --- Accounts ----------------------------------------------------------

  getAccount(address: string) {
    return {
      address,
      balance: this.state.getBalance(address),
      nonce: this.state.getNonce(address),
      nextNonce: this.getNextNonce(address),
    };
  }

  /** Confirmed nonce + any contiguous pending txs, so a wallet can send several in a row. */
  getNextNonce(address: string): number {
    let next = this.state.getNonce(address);
    while (this.pendingTransactions.some((t) => t.from === address && t.nonce === next)) {
      next++;
    }
    return next;
  }

  // --- Mempool -----------------------------------------------------------

  addTransaction(tx: Transaction): { added: boolean; reason?: string } {
    const check = verifyTransaction(tx);
    if (!check.valid) return { added: false, reason: check.reason };

    if (this.pendingTransactions.some((t) => t.hash === tx.hash)) {
      return { added: false, reason: 'duplicate transaction' };
    }
    if (tx.nonce < this.state.getNonce(tx.from)) {
      return { added: false, reason: 'nonce already used' };
    }
    if (this.pendingTransactions.some((t) => t.from === tx.from && t.nonce === tx.nonce)) {
      return { added: false, reason: 'another pending tx from this sender already uses this nonce' };
    }
    if (this.state.getBalance(tx.from) < tx.amount) {
      return { added: false, reason: 'insufficient balance' };
    }

    this.pendingTransactions.push(tx);
    this.persist();
    return { added: true };
  }

  /**
   * Picks the mempool txs that would actually be valid in the next block,
   * in an order that respects each sender's nonce sequence.
   */
  selectTransactionsForBlock(): Transaction[] {
    const sim = this.state.clone();
    const sorted = [...this.pendingTransactions].sort(
      (a, b) => a.nonce - b.nonce || a.timestamp - b.timestamp
    );
    const selected: Transaction[] = [];
    for (const tx of sorted) {
      if (sim.applyAll([tx]).ok) selected.push(tx);
    }
    return selected;
  }

  /** Drops txs whose nonce has already been consumed on-chain. */
  private pruneMempool() {
    this.pendingTransactions = this.pendingTransactions.filter(
      (t) => t.nonce >= this.state.getNonce(t.from)
    );
  }

  // --- Slots -------------------------------------------------------------

  getSlot(timestampMs: number): number {
    return Math.floor(timestampMs / this.slotDurationMs);
  }

  getSlotStart(timestampMs: number): number {
    return this.getSlot(timestampMs) * this.slotDurationMs;
  }

  getTimeIntoSlot(timestampMs: number): number {
    return timestampMs - this.getSlotStart(timestampMs);
  }

  getSlotWaitRemaining(timestampMs: number): number {
    return Math.max(0, this.slotWaitMs - this.getTimeIntoSlot(timestampMs));
  }

  // --- Validation --------------------------------------------------------

  /** Structural PoA rules (linkage, hash, signature, slot ownership). Does NOT look at transactions. */
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

    const blockSlot = this.getSlot(block.timestamp);
    const previousSlot = this.getSlot(previousBlock.timestamp);

    if (blockSlot <= previousSlot) {
      return { valid: false, reason: 'block timestamp falls in an already-used or past time slot' };
    }

    if (this.getTimeIntoSlot(block.timestamp) < this.slotWaitMs) {
      return { valid: false, reason: `block was proposed before the ${this.slotWaitMs}ms slot wait time` };
    }

    const expectedValidator = this.validatorSet.getValidatorForSlot(blockSlot);
    if (block.validatorPublicKey !== expectedValidator) {
      return { valid: false, reason: 'block was not signed by the validator assigned to this time slot' };
    }

    return { valid: true };
  }

  /** Verifies every tx signature in the block, then applies them to `state` atomically. */
  private applyBlockTransactions(block: Block, state: WorldState): { ok: boolean; reason?: string } {
    if (!Array.isArray(block.transactions)) return { ok: false, reason: 'block.transactions is not an array' };

    for (const tx of block.transactions) {
      const check = verifyTransaction(tx);
      if (!check.valid) return { ok: false, reason: `invalid transaction in block: ${check.reason}` };
    }
    const result = state.applyAll(block.transactions);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  addBlock(rawBlock: any): { success: boolean; reason?: string; alreadyHave?: boolean } {
    const block = rawBlock instanceof Block ? rawBlock : Block.fromPlain(rawBlock);
    const latest = this.getLatestBlock();

    if (block.index <= latest.index) {
      return { success: false, reason: 'already have this block or an equal/later one', alreadyHave: true };
    }

    const check = this.isValidNewBlock(block, latest);
    if (!check.valid) return { success: false, reason: check.reason };

    // applyAll is atomic, so a rejected block leaves this.state untouched.
    const txResult = this.applyBlockTransactions(block, this.state);
    if (!txResult.ok) return { success: false, reason: txResult.reason };

    this.chain.push(block);
    this.pruneMempool();
    this.persist();
    return { success: true };
  }

  /** Replays a whole candidate chain from genesis, returning the resulting state if valid. */
  validateChain(rawChain: any[]): ChainValidation {
    if (!Array.isArray(rawChain) || rawChain.length === 0) {
      return { ok: false, reason: 'empty or non-array chain' };
    }

    let chain: Block[];
    try {
      chain = rawChain.map((b) => Block.fromPlain(b));
    } catch {
      return { ok: false, reason: 'malformed block in chain' };
    }

    // Must be rooted in the exact same genesis block as ours.
    const expectedGenesisHash = Block.createGenesisBlock().hash;
    if (chain[0].index !== 0 || chain[0].hash !== expectedGenesisHash) {
      return { ok: false, reason: 'different genesis block' };
    }

    const state = new WorldState(this.genesisAllocations);
    for (let i = 1; i < chain.length; i++) {
      const check = this.isValidNewBlock(chain[i], chain[i - 1]);
      if (!check.valid) return { ok: false, reason: `block #${i}: ${check.reason}` };

      const txResult = this.applyBlockTransactions(chain[i], state);
      if (!txResult.ok) return { ok: false, reason: `block #${i}: ${txResult.reason}` };
    }
    return { ok: true, chain, state };
  }

  isChainValid(rawChain: any[]): boolean {
    return this.validateChain(rawChain).ok;
  }

  replaceChain(rawChain: any[]): { replaced: boolean; reason?: string } {
    if (!Array.isArray(rawChain) || rawChain.length <= this.chain.length) {
      return { replaced: false, reason: 'received chain is not longer than current chain' };
    }
    const result = this.validateChain(rawChain);
    if (!result.ok) {
      return { replaced: false, reason: `received chain failed validation: ${result.reason}` };
    }

    this.chain = result.chain;
    this.state = result.state;
    this.pruneMempool();
    this.persist();
    return { replaced: true };
  }
}