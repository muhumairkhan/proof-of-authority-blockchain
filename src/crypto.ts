import {
  createHash,
  generateKeyPairSync,
  createSign,
  createVerify,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createPrivateKey,
  createPublicKey,
  createECDH,
} from 'crypto';

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface KeyPair {
  publicKey: string; // PEM-encoded (SPKI)
  privateKey: string; // PEM-encoded (PKCS8) — in memory only, never stored
}

/** Generates an ECDSA (secp256k1) key pair. */
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
// Keystore format shared with the frontend (frontend crypto.js / wallet.js)
//
//   private key : raw 32-byte secp256k1 scalar
//   KDF         : PBKDF2-SHA256, 250,000 iterations, 16-byte salt
//   cipher      : AES-256-GCM, 12-byte IV, 16-byte tag APPENDED to ciphertext
//   public key  : SPKI PEM (64-char lines, trailing newline)
//   address     : '0x' + last 40 hex chars of sha256(publicKey PEM)
// ---------------------------------------------------------------------------

export interface EncryptedPrivateKey {
  salt: string; // hex, 16 bytes
  iv: string; // hex, 12 bytes
  ciphertext: string; // hex, AES-256-GCM ciphertext || 16-byte auth tag
}

export interface Keystore {
  version: 1;
  name?: string;
  address: string;
  publicKey: string; // SPKI PEM
  encryptedPrivateKey: EncryptedPrivateKey;
}

const PBKDF2_ITERATIONS = 250_000;
const GCM_TAG_LEN = 16;
// DER header for an uncompressed secp256k1 SPKI public key (ends in 0x04 point marker).
const SPKI_PREFIX_HEX = '3056301006072a8648ce3d020106052b8104000a03420004';

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

function encryptBytes(plain: Uint8Array, passphrase: string): EncryptedPrivateKey {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: ct.toString('hex'),
  };
}

/** Throws on wrong passphrase or tampering (GCM auth failure). */
function decryptBytes(enc: EncryptedPrivateKey, passphrase: string): Buffer {
  const all = Buffer.from(enc.ciphertext, 'hex');
  if (all.length <= GCM_TAG_LEN) throw new Error('ciphertext too short');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, Buffer.from(enc.salt, 'hex')),
    Buffer.from(enc.iv, 'hex')
  );
  decipher.setAuthTag(all.subarray(all.length - GCM_TAG_LEN));
  return Buffer.concat([
    decipher.update(all.subarray(0, all.length - GCM_TAG_LEN)),
    decipher.final(),
  ]);
}

// --- raw key <-> PEM conversions -------------------------------------------

function padTo32(buf: Buffer): Buffer {
  if (buf.length === 32) return buf;
  if (buf.length > 32) throw new Error('private scalar longer than 32 bytes');
  return Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
}

function privateKeyBytesFromPem(pem: string): Buffer {
  const d = createPrivateKey(pem).export({ format: 'jwk' }).d;
  if (!d) throw new Error('could not extract private scalar');
  return padTo32(Buffer.from(d, 'base64url'));
}

/** Real derivation via ECDH — same result as noble's getPublicKey(sk, false) on the frontend. */
function uncompressedPubFromBytes(priv: Uint8Array): Buffer {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(priv));
  return ecdh.getPublicKey(); // 65 bytes: 04 || X || Y
}

export function publicKeyPemFromPrivateKeyBytes(priv: Uint8Array): string {
  const der = Buffer.concat([
    Buffer.from(SPKI_PREFIX_HEX, 'hex'),
    uncompressedPubFromBytes(priv).subarray(1),
  ]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' }).export({
    type: 'spki',
    format: 'pem',
  }) as string;
}

function privateKeyPemFromBytes(priv: Uint8Array): string {
  const pub = uncompressedPubFromBytes(priv);
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'secp256k1',
      d: Buffer.from(priv).toString('base64url'),
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  }).export({ type: 'pkcs8', format: 'pem' }) as string;
}

// --- address ---------------------------------------------------------------

/**
 * Re-exports the key through Node so CRLF / missing-trailing-newline PEMs
 * hash to the same address. Throws on garbage or non-secp256k1 keys.
 */
export function canonicalPublicKeyPem(pem: string): string {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp256k1') {
    throw new Error('public key must be secp256k1');
  }
  return key.export({ type: 'spki', format: 'pem' }) as string;
}

/** Throws if the public key is invalid. */
export function addressFromPublicKey(publicKeyPem: string): string {
  return '0x' + sha256(canonicalPublicKeyPem(publicKeyPem)).slice(-40);
}

// --- keystore create / unlock ----------------------------------------------

export function createKeystore(passphrase: string, name?: string): Keystore {
  const { publicKey, privateKey } = generateValidatorKeyPair();
  const raw = privateKeyBytesFromPem(privateKey);
  try {
    return {
      version: 1,
      ...(name ? { name } : {}),
      address: addressFromPublicKey(publicKey),
      publicKey,
      encryptedPrivateKey: encryptBytes(raw, passphrase),
    };
  } finally {
    raw.fill(0);
  }
}

/**
 * Validates and decrypts a keystore (made by core OR the frontend).
 * Checks: shape, address == hash(publicKey), GCM auth (wrong passphrase /
 * tampering), and that the decrypted key really produces publicKey.
 * Throws on any failure — callers should fail closed.
 */
export function unlockKeystore(ks: any, passphrase: string): KeyPair & { address: string } {
  const enc = ks?.encryptedPrivateKey;
  const isHex = (s: any) =>
    typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s);

  if (
    typeof ks?.address !== 'string' ||
    typeof ks?.publicKey !== 'string' ||
    !enc ||
    !isHex(enc.salt) ||
    !isHex(enc.iv) ||
    !isHex(enc.ciphertext)
  ) {
    throw new Error('keystore is missing required fields');
  }

  const canonicalPub = canonicalPublicKeyPem(ks.publicKey);
  if (addressFromPublicKey(ks.publicKey) !== ks.address) {
    throw new Error('keystore address does not match its public key');
  }

  const raw = decryptBytes(enc, passphrase); // throws on wrong passphrase
  try {
    if (publicKeyPemFromPrivateKeyBytes(raw) !== canonicalPub) {
      throw new Error('decrypted key does not match keystore public key');
    }
    return {
      address: ks.address,
      publicKey: canonicalPub,
      privateKey: privateKeyPemFromBytes(raw),
    };
  } finally {
    raw.fill(0);
  }
}