export interface Transaction {
  from: string; // sender address (derived from publicKey)
  to: string; // recipient address
  amount: number; // positive safe integer
  nonce: number; // sender's tx counter; must equal the account's current nonce
  timestamp: number;
  publicKey: string; // PEM; must hash to `from`
  signature: string; // signature over `hash`
  hash: string; // sha256 of the signed fields (also the tx id)
}

export type UnsignedTransaction = Omit<Transaction, 'publicKey' | 'signature' | 'hash'>;