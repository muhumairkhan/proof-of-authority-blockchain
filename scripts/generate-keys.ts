import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { createKeystore } from '../src/crypto';
import 'dotenv/config';

// Configurable so `reset`/`start` can agree on how many validators to spin up,
// e.g. NUM_VALIDATORS=5 npm run reset
const NUM_VALIDATORS = Number(process.env.NUM_VALIDATORS || 1);

// Validator i gets API port BASE_API_PORT + i and P2P port BASE_P2P_PORT + i.
// These are written INTO keys/validator-i.json (the "node" section) so that
// src/node.ts can discover its own ports and its peers from the key files
// alone — no PEERS / API_PORT / P2P_PORT env vars needed.
const BASE_API_PORT = Number(process.env.BASE_API_PORT || 3000);
const BASE_P2P_PORT = Number(process.env.BASE_P2P_PORT || 6000);

// Private keys are encrypted at rest (AES-256-GCM, key derived from this
// passphrase via PBKDF2). The passphrase itself is never written to disk —
// you supply it again whenever a validator node starts up, so losing it
// means losing access to that validator's signing key.
//
// The keystore part of the file is identical to the frontend wallet's format;
// the extra "node" section is ignored by the frontend.
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
  const ks = createKeystore(passphrase, `validator-${i}`);
  const node = {
    validatorIndex: i,
    apiPort: BASE_API_PORT + i,
    p2pPort: BASE_P2P_PORT + i,
  };

  writeFileSync(`keys/validator-${i}.json`, JSON.stringify({ ...ks, node }, null, 2));
  publicKeys.push(ks.publicKey);
  console.log(
    `Generated keys/validator-${i}.json (${ks.address}) — API :${node.apiPort}  P2P :${node.p2pPort}`
  );
}

// The rotation order every node needs to agree on who signs which slot.
// Public keys only — safe to distribute.
writeFileSync('keys/validators-public.json', JSON.stringify(publicKeys, null, 2));
console.log(`Wrote keys/validators-public.json (${NUM_VALIDATORS} validators, shared rotation order for all nodes)`);