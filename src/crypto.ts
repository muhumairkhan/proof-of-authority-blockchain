import { createHash, generateKeyPairSync, createSign, createVerify } from 'crypto';

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
