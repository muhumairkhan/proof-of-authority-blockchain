import { readFileSync, existsSync } from 'fs';
import { Blockchain } from './blockchain';
import { ValidatorSet } from './validatorSet';
import { P2PNode } from './p2p';
import { startApi } from './api';
import { KeyPair } from './crypto';

const API_PORT = Number(process.env.API_PORT || 3000);
const P2P_PORT = Number(process.env.P2P_PORT || 6000);
const PEERS = (process.env.PEERS || '').split(',').filter(Boolean);
// Which key file this node holds, e.g. "0", "1", "2". Omit to run as a
// non-validating full node (still syncs the chain and accepts transactions).
const VALIDATOR_INDEX = process.env.VALIDATOR_INDEX;

if (!existsSync('keys/validators-public.json')) {
  console.error('Missing keys/validators-public.json — run `npm run generate-keys` first.');
  process.exit(1);
}

const publicKeys: string[] = JSON.parse(readFileSync('keys/validators-public.json', 'utf-8'));
const validatorSet = new ValidatorSet(publicKeys);

let myKeys: KeyPair | null = null;
if (VALIDATOR_INDEX !== undefined) {
  const path = `keys/validator-${VALIDATOR_INDEX}.json`;
  if (!existsSync(path)) {
    console.error(`No key file found at ${path}`);
    process.exit(1);
  }
  myKeys = JSON.parse(readFileSync(path, 'utf-8'));
  console.log(`[node] Running as validator #${VALIDATOR_INDEX}`);
} else {
  console.log('[node] Running as a non-validating full node');
}

const blockchain = new Blockchain(validatorSet);
const p2p = new P2PNode(blockchain, P2P_PORT);
p2p.start();

for (const peer of PEERS) {
  p2p.connectToPeer(peer);
}

startApi(blockchain, p2p, API_PORT, myKeys);
