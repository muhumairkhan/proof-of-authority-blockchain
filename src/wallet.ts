import {
  addressFromPublicKey,
  createKeystore,
  Keystore,
  KeyPair,
  unlockKeystore,
} from "./crypto";
import { createSignedTransaction, verifyTransaction } from "./transaction";
import { Transaction } from "./types";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * One keystore = one account. Pure identity + signing: no files, no network.
 *
 *   locked   : holds only the encrypted keystore (address / publicKey are readable)
 *   unlocked : also holds the decrypted key pair in memory, so it can sign
 *
 * Persistence lives in WalletStore, talking to a node lives in NodeClient.
 */
export class Wallet {
  private keys: KeyPair | null = null;

  private constructor(private readonly ks: Keystore) {}

  // --- construction ---------------------------------------------------------

  /** Generates a brand-new wallet. Returned unlocked. */
  static create(passphrase: string, name?: string): Wallet {
    return Wallet.fromKeystore(createKeystore(passphrase, name)).unlock(
      passphrase,
    );
  }

  /**
   * Wraps an existing keystore WITHOUT a passphrase (returned locked).
   * Checks shape and that the address really belongs to the public key,
   * but cannot check the encrypted key until unlock().
   */
  static fromKeystore(ks: any): Wallet {
    const enc = ks?.encryptedPrivateKey;
    if (
      typeof ks?.address !== "string" ||
      typeof ks?.publicKey !== "string" ||
      typeof enc?.salt !== "string" ||
      typeof enc?.iv !== "string" ||
      typeof enc?.ciphertext !== "string"
    ) {
      throw new Error("keystore is missing required fields");
    }

    let derived: string;
    try {
      derived = addressFromPublicKey(ks.publicKey);
    } catch {
      throw new Error("keystore has an invalid public key");
    }
    if (derived !== ks.address) {
      throw new Error("keystore address does not match its public key");
    }

    return new Wallet({
      version: 1,
      ...(typeof ks.name === "string" && ks.name ? { name: ks.name } : {}),
      address: ks.address,
      publicKey: ks.publicKey,
      encryptedPrivateKey: {
        salt: enc.salt,
        iv: enc.iv,
        ciphertext: enc.ciphertext,
      },
    });
  }

  /** Restores a keystore (e.g. exported from the frontend) and proves the passphrase. Returned unlocked. */
  static import(ks: any, passphrase: string): Wallet {
    return Wallet.fromKeystore(ks).unlock(passphrase);
  }

  // --- identity -------------------------------------------------------------

  get address(): string {
    return this.ks.address;
  }

  get publicKey(): string {
    return this.ks.publicKey;
  }

  get name(): string | undefined {
    return this.ks.name;
  }

  get isUnlocked(): boolean {
    return this.keys !== null;
  }

  // --- lock / unlock --------------------------------------------------------

  /** Decrypts the key into memory. Throws on wrong passphrase or a tampered keystore. */
  unlock(passphrase: string): this {
    const { publicKey, privateKey } = unlockKeystore(this.ks, passphrase);
    this.keys = { publicKey, privateKey };
    return this;
  }

  /**
   * Drops the in-memory key. Best effort only: JS strings can't be zeroed,
   * so this removes our reference but the GC decides when the bytes go away.
   */
  lock(): void {
    this.keys = null;
  }

  // --- signing --------------------------------------------------------------

  /** Builds and signs a transfer. The caller supplies the nonce (see NodeClient.send). */
  createTransaction(to: string, amount: number, nonce: number): Transaction {
    if (!this.keys)
      throw new Error("wallet is locked — call unlock(passphrase) first");

    const dest = typeof to === "string" ? to.trim().toLowerCase() : "";
    if (!ADDRESS_RE.test(dest)) {
      throw new Error("recipient must be a lowercase 0x + 40 hex address");
    }
    if (dest === this.address) throw new Error("cannot send to self");
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error("amount must be a positive integer");
    }
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new Error("nonce must be a non-negative integer");
    }

    const tx = createSignedTransaction(
      { from: this.address, to: dest, amount, nonce, timestamp: Date.now() },
      this.keys.publicKey,
      this.keys.privateKey,
    );

    // Same stateless checks every node will run — fail here instead of on the network.
    const check = verifyTransaction(tx);
    if (!check.valid)
      throw new Error(`built an invalid transaction: ${check.reason}`);
    return tx;
  }

  // --- export ---------------------------------------------------------------

  /** Standard keystore JSON (same format as the frontend). Still encrypted. */
  exportKeystore(name?: string): Keystore {
    const finalName = name ?? this.ks.name;
    return {
      version: 1,
      ...(finalName ? { name: finalName } : {}),
      address: this.ks.address,
      publicKey: this.ks.publicKey,
      encryptedPrivateKey: { ...this.ks.encryptedPrivateKey },
    };
  }
}
