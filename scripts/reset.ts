import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import 'dotenv/config';

// Test wallet created fresh on every reset, pre-funded so you can start
// sending transactions immediately without hand-editing genesis.json.
// Override the passphrase with TEST_WALLET_PASSPHRASE if you want; it's
// only test money, so a fixed default is fine.
const TEST_WALLET_NAME = 'test';
const TEST_WALLET_PASSPHRASE = process.env.TEST_WALLET_PASSPHRASE || 'test';
const TEST_WALLET_FUNDS = Number(process.env.TEST_WALLET_FUNDS || 1000);

// Optional: also fund an address you control elsewhere (e.g. a frontend
// wallet). Copy its 0x address from the frontend, then:
//   GENESIS_ADDRESS=0xabc... npm run reset
const GENESIS_ADDRESS = (process.env.GENESIS_ADDRESS || '').toLowerCase();
const GENESIS_ADDRESS_FUNDS = Number(process.env.GENESIS_ADDRESS_FUNDS || 1000);

if (GENESIS_ADDRESS && !/^0x[0-9a-f]{40}$/.test(GENESIS_ADDRESS)) {
  console.error('[reset] GENESIS_ADDRESS must be 0x followed by 40 hex characters');
  process.exit(1);
}

for (const path of ['keys', 'data', 'wallets']) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    console.log(`[reset] Removed ${path}`);
  } else {
    console.log(`[reset] ${path} did not exist, skipping`);
  }
}

console.log('[reset] Generating fresh validator keys...');
execSync('npm run generate-keys', { stdio: 'inherit' });

console.log(`[reset] Creating test wallet "${TEST_WALLET_NAME}"...`);
execSync(`npm run wallet -- create ${TEST_WALLET_NAME}`, {
  stdio: 'inherit',
  env: { ...process.env, WALLET_PASSPHRASE: TEST_WALLET_PASSPHRASE },
});

const wallet = JSON.parse(readFileSync(`wallets/${TEST_WALLET_NAME}.json`, 'utf-8')) as { address: string };

const genesis: Record<string, number> = { [wallet.address]: TEST_WALLET_FUNDS };
if (GENESIS_ADDRESS) genesis[GENESIS_ADDRESS] = GENESIS_ADDRESS_FUNDS;

// make sure data/ dir exists for genesis.json to write
if (!existsSync('data')) {
  mkdirSync('data');
}

writeFileSync('data/genesis.json', JSON.stringify(genesis, null, 2));
console.log(`[reset] Wrote data/genesis.json — ${wallet.address} funded with ${TEST_WALLET_FUNDS}`);
if (GENESIS_ADDRESS) {
  console.log(`[reset] Also funded ${GENESIS_ADDRESS} with ${GENESIS_ADDRESS_FUNDS}`);
}
console.log(`[reset] Test wallet passphrase: ${TEST_WALLET_PASSPHRASE} (override with TEST_WALLET_PASSPHRASE env var)`);

console.log('[reset] Done.');