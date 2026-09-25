import { sha256, sign, verify, addressFromPublicKey } from './crypto';
import { Transaction, UnsignedTransaction } from './types';

/** Hash of exactly the fields the sender commits to. Also serves as the tx id. */
export function computeTxHash(tx: UnsignedTransaction): string {
  return sha256(
    JSON.stringify({
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      nonce: tx.nonce,
      timestamp: tx.timestamp,
    })
  );
}

export function createSignedTransaction(
  unsigned: UnsignedTransaction,
  publicKey: string,
  privateKey: string
): Transaction {
  const hash = computeTxHash(unsigned);
  const signature = sign(hash, privateKey);
  return { ...unsigned, publicKey, signature, hash };
}

/**
 * Stateless checks only (shape, hash, address ownership, signature).
 * Balance and nonce checks need chain state and live in WorldState.
 * Accepts `any` because this runs on data from the network.
 */
export function verifyTransaction(tx: any): { valid: boolean; reason?: string } {
  if (!tx || typeof tx !== 'object') return { valid: false, reason: 'transaction is not an object' };

  const { from, to, amount, nonce, timestamp, publicKey, signature, hash } = tx;
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof publicKey !== 'string' ||
    typeof signature !== 'string' ||
    typeof hash !== 'string'
  ) {
    return { valid: false, reason: 'malformed transaction fields' };
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { valid: false, reason: 'amount must be a positive integer' };
  }
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    return { valid: false, reason: 'nonce must be a non-negative integer' };
  }
  if (!Number.isSafeInteger(timestamp)) {
    return { valid: false, reason: 'timestamp must be an integer' };
  }
  if (from === to) return { valid: false, reason: 'cannot send to self' };

  if (addressFromPublicKey(publicKey) !== from) {
    return { valid: false, reason: 'publicKey does not match sender address' };
  }
  if (computeTxHash({ from, to, amount, nonce, timestamp }) !== hash) {
    return { valid: false, reason: 'tx hash does not match contents' };
  }
  if (!verify(hash, signature, publicKey)) {
    return { valid: false, reason: 'invalid signature' };
  }
  return { valid: true };
}