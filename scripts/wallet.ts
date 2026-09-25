import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
  generateValidatorKeyPair,
  encryptPrivateKey,
  decryptPrivateKey,
  addressFromPublicKey,
  EncryptedPrivateKey,
} from '../src/crypto';
import { createSignedTransaction } from '../src/transaction';
import 'dotenv/config';

// Usage:
//   WALLET_PASSPHRASE=... npm run wallet -- create alice
//   npm run wallet -- address alice
//   npm run wallet -- balance alice            (or a raw 0x... address)
//   WALLET_PASSPHRASE=... npm run wallet -- send alice bob 10
//
// NODE_URL selects which node's API to talk to (default http://localhost:3000).

const NODE_URL = process.env.NODE_URL || 'http://localhost:3000';
const WALLET_DIR = 'wallets';

interface StoredWallet {
  address: string;
  publicKey: string;
  encryptedPrivateKey: EncryptedPrivateKey;
}

function walletPath(name: string) {
  return `${WALLET_DIR}/${name}.json`;
}

function loadWallet(name: string): StoredWallet {
  const path = walletPath(name);
  if (!existsSync(path)) {
    console.error(`No wallet found at ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Accepts either a raw 0x address or the name of a local wallet. */
function resolveAddress(nameOrAddress: string): string {
  if (nameOrAddress.startsWith('0x')) return nameOrAddress;
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
      const passphrase = requirePassphrase();
      const { publicKey, privateKey } = generateValidatorKeyPair();
      const wallet: StoredWallet = {
        address: addressFromPublicKey(publicKey),
        publicKey,
        encryptedPrivateKey: encryptPrivateKey(privateKey, passphrase),
      };
      if (!existsSync(WALLET_DIR)) mkdirSync(WALLET_DIR);
      writeFileSync(walletPath(name), JSON.stringify(wallet, null, 2));
      console.log(`Created ${walletPath(name)}`);
      console.log(`Address: ${wallet.address}`);
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
      let privateKey: string;
      try {
        privateKey = decryptPrivateKey(wallet.encryptedPrivateKey, requirePassphrase());
      } catch {
        console.error('Failed to decrypt wallet — wrong WALLET_PASSPHRASE?');
        process.exit(1);
      }

      // Ask the node for the next usable nonce (counts this account's pending txs too).
      const acctRes = await fetch(`${NODE_URL}/accounts/${wallet.address}`);
      const acct = (await acctRes.json()) as { nextNonce: number };

      console.log(acct);

      const tx = createSignedTransaction(
        {
          from: wallet.address,
          to: resolveAddress(toWho),
          amount,
          nonce: acct.nextNonce,
          timestamp: Date.now(),
        },
        wallet.publicKey,
        privateKey
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