import { rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import 'dotenv/config';

// Test wallet created fresh on every reset, pre-funded so you can start
// sending transactions immediately without hand-editing genesis.json.
// Override the passphrase with TEST_WALLET_PASSPHRASE if you want; it's
// only test money, so a fixed default is fine.
const TEST_WALLET_NAME = 'test';
const TEST_WALLET_PASSPHRASE = process.env.TEST_WALLET_PASSPHRASE || 'test-wallet-passphrase';
const TEST_WALLET_FUNDS = Number(process.env.TEST_WALLET_FUNDS || 1000);

for (const path of ['keys', 'data', 'wallets', 'genesis.json']) {
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

const genesis = { [wallet.address]: TEST_WALLET_FUNDS };
writeFileSync('genesis.json', JSON.stringify(genesis, null, 2));
console.log(`[reset] Wrote genesis.json — ${wallet.address} funded with ${TEST_WALLET_FUNDS}`);
console.log(`[reset] Test wallet passphrase: ${TEST_WALLET_PASSPHRASE} (override with TEST_WALLET_PASSPHRASE env var)`);

console.log('[reset] Done.');