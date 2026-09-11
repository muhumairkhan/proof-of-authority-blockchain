import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { generateValidatorKeyPair, encryptPrivateKey } from '../src/crypto';

// Configurable so `reset`/`start` can agree on how many validators to spin up,
// e.g. NUM_VALIDATORS=5 npm run reset
const NUM_VALIDATORS = Number(process.env.NUM_VALIDATORS || 1);

// Private keys are encrypted at rest with AES-256-GCM using a key derived
// from this passphrase (scrypt). It is never written to disk itself — you
// supply it again whenever a validator node starts up, so losing it means
// losing access to that validator's signing key.
const passphrase = process.env.VALIDATOR_KEY_PASSPHRASE;
if (!passphrase) {
  console.error(
    '[generate-keys] Missing VALIDATOR_KEY_PASSPHRASE.\n' +
    '        Private keys are encrypted at rest and require a passphrase to protect them.\n' +
    '        Example:\n' +
    '          VALIDATOR_KEY_PASSPHRASE="correct horse battery staple" npm run generate-keys'
  );
  process.exit(1);
}

if (!existsSync('keys')) {
  mkdirSync('keys');
}

const publicKeys: string[] = [];

for (let i = 0; i < NUM_VALIDATORS; i++) {
  const { publicKey, privateKey } = generateValidatorKeyPair();
  const encryptedPrivateKey = encryptPrivateKey(privateKey, passphrase);

  // Note: no plaintext privateKey field — only the public key (safe to
  // share) and the encrypted blob are ever persisted.
  writeFileSync(
    `keys/validator-${i}.json`,
    JSON.stringify({ publicKey, encryptedPrivateKey }, null, 2)
  );
  publicKeys.push(publicKey);
  console.log(`Generated keys/validator-${i}.json (private key encrypted at rest)`);
}

// The rotation order every node needs to agree on who signs block N.
// Public keys only — safe to distribute/commit if you really want to,
// though keys/ is gitignored by default.
writeFileSync('keys/validators-public.json', JSON.stringify(publicKeys, null, 2));
console.log(`Wrote keys/validators-public.json (${NUM_VALIDATORS} validators, shared rotation order for all nodes)`);