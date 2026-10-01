import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createKeystore, unlockKeystore, Keystore, KeyPair } from '../src/crypto';
import { createSignedTransaction } from '../src/transaction';
import 'dotenv/config';

// Usage:
//   WALLET_PASSPHRASE=... npm run wallet -- create alice
//   WALLET_PASSPHRASE=... npm run wallet -- import ./exported-keystore.json alice
//   npm run wallet -- address alice
//   npm run wallet -- balance alice            (or a raw 0x... address)
//   WALLET_PASSPHRASE=... npm run wallet -- send alice bob 10
//
// Wallet files use the SAME keystore format as the frontend, so a keystore
// exported from the frontend can be imported here and vice versa.
//
// NODE_URL selects which node's API to talk to (default http://localhost:3000).

const NODE_URL = process.env.NODE_URL || 'http://localhost:3000';
const WALLET_DIR = 'wallets';

function walletPath(name: string) {
  return `${WALLET_DIR}/${name}.json`;
}

function loadWallet(name: string): Keystore {
  const path = walletPath(name);
  if (!existsSync(path)) {
    console.error(`No wallet found at ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Accepts either a raw 0x address or the name of a local wallet. */
function resolveAddress(nameOrAddress: string): string {
  if (nameOrAddress.startsWith('0x')) return nameOrAddress.toLowerCase();
  return loadWallet(nameOrAddress).address;
}

function requirePassphrase(): string {
  const passphrase = process.env.WALLET_PASSPHRASE;
  if (!passphrase) {
    console.error('Missing WALLET_PASSPHRASE (used to encrypt/decrypt the wallet private key).');
    process.exit(1);
  }
  return passphrase;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'create': {
      const [name] = args;
      if (!name) return usage();
      if (existsSync(walletPath(name))) {
        console.error(`Wallet "${name}" already exists at ${walletPath(name)}`);
        process.exit(1);
      }
      const ks = createKeystore(requirePassphrase(), name);
      if (!existsSync(WALLET_DIR)) mkdirSync(WALLET_DIR);
      writeFileSync(walletPath(name), JSON.stringify(ks, null, 2));
      console.log(`Created ${walletPath(name)}`);
      console.log(`Address: ${ks.address}`);
      break;
    }

    case 'import': {
      const [file, name] = args;
      if (!file || !name) return usage();
      if (!existsSync(file)) {
        console.error(`Keystore file not found: ${file}`);
        process.exit(1);
      }
      if (existsSync(walletPath(name))) {
        console.error(`Wallet "${name}" already exists at ${walletPath(name)}`);
        process.exit(1);
      }
      let ks: any;
      try {
        ks = JSON.parse(readFileSync(file, 'utf-8'));
      } catch {
        console.error('Keystore is not valid JSON');
        process.exit(1);
      }
      try {
        unlockKeystore(ks, requirePassphrase()); // proves passphrase + integrity
      } catch (e) {
        console.error(`Import failed: ${(e as Error).message}`);
        process.exit(1);
      }
      if (!existsSync(WALLET_DIR)) mkdirSync(WALLET_DIR);
      // Keep only the standard fields; store the original encrypted blob untouched.
      const clean: Keystore = {
        version: 1,
        name,
        address: ks.address,
        publicKey: ks.publicKey,
        encryptedPrivateKey: {
          salt: ks.encryptedPrivateKey.salt,
          iv: ks.encryptedPrivateKey.iv,
          ciphertext: ks.encryptedPrivateKey.ciphertext,
        },
      };
      writeFileSync(walletPath(name), JSON.stringify(clean, null, 2));
      console.log(`Imported as ${walletPath(name)}`);
      console.log(`Address: ${clean.address}`);
      break;
    }

    case 'address': {
      const [name] = args;
      if (!name) return usage();
      console.log(loadWallet(name).address);
      break;
    }

    case 'balance': {
      const [who] = args;
      if (!who) return usage();
      const address = resolveAddress(who);
      const res = await fetch(`${NODE_URL}/accounts/${address}`);
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }

    case 'send': {
      const [fromName, toWho, amountStr] = args;
      if (!fromName || !toWho || !amountStr) return usage();
      const amount = Number(amountStr);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        console.error('amount must be a positive integer');
        process.exit(1);
      }

      const wallet = loadWallet(fromName);
      let keys: KeyPair & { address: string };
      try {
        keys = unlockKeystore(wallet, requirePassphrase());
      } catch (e) {
        console.error(`Failed to unlock wallet: ${(e as Error).message}`);
        process.exit(1);
      }

      const to = resolveAddress(toWho);
      if (!/^0x[0-9a-f]{40}$/.test(to)) {
        console.error('recipient must be a wallet name or a lowercase 0x + 40 hex address');
        process.exit(1);
      }

      // Ask the node for the next usable nonce (counts this account's pending txs too).
      const acctRes = await fetch(`${NODE_URL}/accounts/${keys.address}`);
      const acct = (await acctRes.json()) as { nextNonce: number };

      console.log(acct);

      const tx = createSignedTransaction(
        {
          from: keys.address,
          to,
          amount,
          nonce: acct.nextNonce,
          timestamp: Date.now(),
        },
        keys.publicKey,
        keys.privateKey
      );

      const res = await fetch(`${NODE_URL}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tx),
      });
      console.log(res.status, JSON.stringify(await res.json(), null, 2));
      break;
    }

    default:
      usage();
  }
}

function usage() {
  console.error(
    'Usage:\n' +
    '  npm run wallet -- create <name>\n' +
    '  npm run wallet -- import <keystore.json> <name>\n' +
    '  npm run wallet -- address <name>\n' +
    '  npm run wallet -- balance <name|0xaddress>\n' +
    '  npm run wallet -- send <fromName> <toName|0xaddress> <amount>'
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});