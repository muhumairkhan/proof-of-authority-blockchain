import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { generateValidatorKeyPair } from '../src/crypto';

const NUM_VALIDATORS = 1;

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
console.log('Wrote keys/validators-public.json (shared rotation order for all nodes)');
