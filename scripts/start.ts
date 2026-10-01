import { existsSync } from 'fs';
import { spawn, execSync, ChildProcess } from 'child_process';
import { discoverValidatorNodes } from '../src/nodeInfo';
import 'dotenv/config';

// `npm start -- reset` (or `npm run start -- reset`) wipes keys/data and
// regenerates keys before starting, so you can go from zero to running
// nodes in one command.
const shouldReset = process.argv.slice(2).includes('reset');

if (shouldReset) {
  console.log('[start] "reset" flag detected — resetting keys/data first...');
  execSync('npm run reset', { stdio: 'inherit' });
}

if (!existsSync('keys/validators-public.json')) {
  console.error(
    '[start] Missing keys/validators-public.json.\n' +
    '        Run `npm run generate-keys` first, or `npm start -- reset` to do it automatically.'
  );
  process.exit(1);
}

// Private keys are encrypted at rest (see src/crypto.ts). Every validator
// process spawned below needs this passphrase to decrypt its own key, so
// check it up front rather than letting each child fail separately.
if (!process.env.VALIDATOR_KEY_PASSPHRASE) {
  console.error(
    '[start] Missing VALIDATOR_KEY_PASSPHRASE.\n' +
    '        Set it to the same passphrase used with `npm run generate-keys`, e.g.\n' +
    '          VALIDATOR_KEY_PASSPHRASE="correct horse battery staple" npm start'
  );
  process.exit(1);
}

// Each node's own ports come from its keys/validator-*.json (see src/nodeInfo.ts),
// so each child only needs to be told WHICH validator it is. Peers are found
// through the bootnode: validator 0, unless BOOTNODES is set explicitly.
let nodes;
try {
  nodes = discoverValidatorNodes('keys');
} catch (err) {
  console.error(`[start] ${(err as Error).message}`);
  process.exit(1);
}

if (nodes.length === 0) {
  console.error('[start] No keys/validator-*.json files found.');
  process.exit(1);
}

const children: ChildProcess[] = [];
let shuttingDown = false;

console.log(`[start] Found ${nodes.length} validator key file(s) — starting ${nodes.length} node(s)...`);

for (const n of nodes) {
  console.log(`[start] validator #${n.validatorIndex} -> API :${n.apiPort}  P2P :${n.p2pPort}`);

  const child = spawn('npx', ['ts-node', 'src/node.ts'], {
    env: {
      ...process.env,
      VALIDATOR_INDEX: String(n.validatorIndex),
      BOOTNODES: process.env.BOOTNODES ?? `ws://localhost:${nodes[0].p2pPort}`,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[start] validator #${n.validatorIndex} (P2P :${n.p2pPort}) exited unexpectedly with code ${code}`);
    }
  });

  children.push(child);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[start] Shutting down all nodes...');
  for (const child of children) {
    child.kill();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);