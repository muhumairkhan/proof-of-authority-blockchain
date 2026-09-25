import { Transaction } from './types';

/** address -> starting balance. Must be identical on every node. */
export type GenesisAllocations = Record<string, number>;

interface Account {
  balance: number;
  nonce: number; // the nonce the NEXT tx from this account must carry
}

/**
 * Derived state: balances + nonces. Never persisted — it is always
 * rebuildable by replaying the chain from genesis.
 */
export class WorldState {
  private accounts = new Map<string, Account>();

  constructor(genesis: GenesisAllocations = {}) {
    for (const [address, balance] of Object.entries(genesis)) {
      this.accounts.set(address, { balance, nonce: 0 });
    }
  }

  private get(address: string): Account {
    return this.accounts.get(address) ?? { balance: 0, nonce: 0 };
  }

  getBalance(address: string): number {
    return this.get(address).balance;
  }

  getNonce(address: string): number {
    return this.get(address).nonce;
  }

  clone(): WorldState {
    const copy = new WorldState();
    for (const [address, account] of this.accounts) {
      copy.accounts.set(address, { ...account });
    }
    return copy;
  }

  /**
   * Applies txs in order. All-or-nothing: if any tx is invalid, state is
   * left untouched and the reason is returned.
   */
  applyAll(txs: Transaction[]): { ok: true } | { ok: false; reason: string } {
    const working = this.clone();

    for (const tx of txs) {
      const sender = working.get(tx.from);
      if (tx.nonce !== sender.nonce) {
        return {
          ok: false,
          reason: `bad nonce for ${tx.from.slice(0, 10)}...: expected ${sender.nonce}, got ${tx.nonce}`,
        };
      }
      if (sender.balance < tx.amount) {
        return {
          ok: false,
          reason: `insufficient balance for ${tx.from.slice(0, 10)}...: has ${sender.balance}, needs ${tx.amount}`,
        };
      }
      working.accounts.set(tx.from, { balance: sender.balance - tx.amount, nonce: sender.nonce + 1 });
      const receiver = working.get(tx.to);
      working.accounts.set(tx.to, { balance: receiver.balance + tx.amount, nonce: receiver.nonce });
    }

    this.accounts = working.accounts;
    return { ok: true };
  }
}