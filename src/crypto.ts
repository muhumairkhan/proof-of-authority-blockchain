import {
  createHash,
  generateKeyPairSync,
  createSign,
  createVerify,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface KeyPair {
  publicKey: string; // PEM-encoded
  privateKey: string; // PEM-encoded
}

/**
 * Generates an ECDSA (secp256k1) key pair for a validator.
 * secp256k1 is the same curve used by Bitcoin/Ethereum, so this generalizes
 * well if you later add wallet-style transaction signing too.
 */
export function generateValidatorKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

export function sign(data: string, privateKeyPem: string): string {
  const signer = createSign('SHA256');
  signer.update(data);
  signer.end();
  return signer.sign(privateKeyPem, 'hex');
}

export function verify(data: string, signatureHex: string, publicKeyPem: string): boolean {
  const verifier = createVerify('SHA256');
  verifier.update(data);
  verifier.end();
  try {
    return verifier.verify(publicKeyPem, signatureHex, 'hex');
  } catch {
    // Malformed signature or key — treat as invalid rather than crashing.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Private key encryption at rest
//
// Validator private keys must never be written to disk in plaintext. Each
// key file stores an EncryptedPrivateKey blob instead: a passphrase-derived
// AES-256-GCM key encrypts the PEM, and the GCM auth tag lets decryption
// fail loudly (rather than silently producing garbage) if the passphrase is
// wrong or the file was tampered with.
// ---------------------------------------------------------------------------

export interface EncryptedPrivateKey {
  salt: string; // hex, per-key random salt for scrypt
  iv: string; // hex, random 96-bit GCM nonce
  authTag: string; // hex, GCM authentication tag
  ciphertext: string; // hex
}

const SCRYPT_KEYLEN = 32; // 256-bit key for AES-256-GCM

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT_KEYLEN);
}

export function encryptPrivateKey(privateKeyPem: string, passphrase: string): EncryptedPrivateKey {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKeyPem, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Throws if the passphrase is wrong or the ciphertext/authTag were altered —
 * callers should catch this and fail closed (never fall back to an
 * unauthenticated or empty key).
 */
export function decryptPrivateKey(enc: EncryptedPrivateKey, passphrase: string): string {
  const salt = Buffer.from(enc.salt, 'hex');
  const iv = Buffer.from(enc.iv, 'hex');
  const authTag = Buffer.from(enc.authTag, 'hex');
  const ciphertext = Buffer.from(enc.ciphertext, 'hex');
  const key = deriveKey(passphrase, salt);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf-8');
}