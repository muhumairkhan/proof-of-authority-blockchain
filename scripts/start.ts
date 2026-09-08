import { readFileSync, existsSync } from 'fs';
import { spawn, execSync, ChildProcess } from 'child_process';

const BASE_API_PORT = Number(process.env.BASE_API_PORT || 3000);
const BASE_P2P_PORT = Number(process.env.BASE_P2P_PORT || 6000);

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

const publicKeys: string[] = JSON.parse(readFileSync('keys/validators-public.json', 'utf-8'));
const numValidators = publicKeys.length;

if (numValidators === 0) {
  console.error('[start] keys/validators-public.json contains no validators.');
  process.exit(1);
}

const p2pPorts = Array.from({ length: numValidators }, (_, i) => BASE_P2P_PORT + i);
const children: ChildProcess[] = [];
let shuttingDown = false;

console.log(`[start] Found ${numValidators} validator(s) in keys/validators-public.json — starting ${numValidators} node(s)...`);

for (let i = 0; i < numValidators; i++) {
  const apiPort = BASE_API_PORT + i;
  const p2pPort = BASE_P2P_PORT + i;
  const peers = p2pPorts
    .filter((p) => p !== p2pPort)
    .map((p) => `ws://localhost:${p}`)
    .join(',');

  console.log(`[start] validator #${i} -> API :${apiPort}  P2P :${p2pPort}  peers: [${peers || 'none'}]`);

  const child = spawn('npx', ['ts-node', 'src/node.ts'], {
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      P2P_PORT: String(p2pPort),
      VALIDATOR_INDEX: String(i),
      PEERS: peers,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[start] validator #${i} (P2P :${p2pPort}) exited unexpectedly with code ${code}`);
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