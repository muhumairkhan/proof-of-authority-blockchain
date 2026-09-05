import { sha256, sign, verify } from './crypto';
import { Transaction } from './types';

export interface BlockData {
  index: number;
  timestamp: number;
  transactions: Transaction[];
  previousHash: string;
  validatorPublicKey: string;
}

export class Block {
  index: number;
  timestamp: number;
  transactions: Transaction[];
  previousHash: string;
  validatorPublicKey: string;
  hash: string;
  signature: string;

  constructor(data: BlockData, hash: string, signature: string) {
    this.index = data.index;
    this.timestamp = data.timestamp;
    this.transactions = data.transactions;
    this.previousHash = data.previousHash;
    this.validatorPublicKey = data.validatorPublicKey;
    this.hash = hash;
    this.signature = signature;
  }

  /** Deterministic hash of the block's content (excludes hash/signature themselves). */
  static computeHash(data: BlockData): string {
    const payload = JSON.stringify({
      index: data.index,
      timestamp: data.timestamp,
      transactions: data.transactions,
      previousHash: data.previousHash,
      validatorPublicKey: data.validatorPublicKey,
    });
    return sha256(payload);
  }

  static createGenesisBlock(): Block {
    const data: BlockData = {
      index: 0,
      timestamp: 0,
      transactions: [],
      previousHash: '0'.repeat(64),
      validatorPublicKey: 'genesis',
    };
    const hash = Block.computeHash(data);
    return new Block(data, hash, 'genesis-signature');
  }

  /** Used by a validator to build and sign the next block. */
  static proposeBlock(data: BlockData, validatorPrivateKey: string): Block {
    const hash = Block.computeHash(data);
    const signature = sign(hash, validatorPrivateKey);
    return new Block(data, hash, signature);
  }

  /**
   * Reconstructs a real Block instance (with working methods) from a plain
   * object — e.g. one that just arrived over the network as parsed JSON.
   */
  static fromPlain(obj: any): Block {
    return new Block(
      {
        index: obj.index,
        timestamp: obj.timestamp,
        transactions: obj.transactions,
        previousHash: obj.previousHash,
        validatorPublicKey: obj.validatorPublicKey,
      },
      obj.hash,
      obj.signature
    );
  }

  isHashValid(): boolean {
    const recomputed = Block.computeHash({
      index: this.index,
      timestamp: this.timestamp,
      transactions: this.transactions,
      previousHash: this.previousHash,
      validatorPublicKey: this.validatorPublicKey,
    });
    return recomputed === this.hash;
  }

  isSignatureValid(): boolean {
    if (this.index === 0) return true; // genesis block is exempt
    return verify(this.hash, this.signature, this.validatorPublicKey);
  }
}
