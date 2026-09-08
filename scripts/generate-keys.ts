import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { generateValidatorKeyPair } from '../src/crypto';

// Configurable so `reset`/`start` can agree on how many validators to spin up,
// e.g. NUM_VALIDATORS=5 npm run reset
const NUM_VALIDATORS = Number(process.env.NUM_VALIDATORS || 1);

if (!existsSync('keys')) {
  mkdirSync('keys');
}

const publicKeys: string[] = [];

for (let i = 0; i < NUM_VALIDATORS; i++) {
  const { publicKey, privateKey } = generateValidatorKeyPair();
  writeFileSync(`keys/validator-${i}.json`, JSON.stringify({ publicKey, privateKey }, null, 2));
  publicKeys.push(publicKey);
  console.log(`Generated keys/validator-${i}.json`);
}

// The rotation order every node needs to agree on who signs block N.
writeFileSync('keys/validators-public.json', JSON.stringify(publicKeys, null, 2));
console.log(`Wrote keys/validators-public.json (${NUM_VALIDATORS} validators, shared rotation order for all nodes)`);