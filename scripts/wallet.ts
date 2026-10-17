import { readFileSync, existsSync } from "fs";
import { Wallet } from "../src/wallet";
import { WalletStore } from "../src/walletStore";
import { NodeClient } from "../src/nodeClient";
import "dotenv/config";

// Usage:
//   WALLET_PASSPHRASE=... npm run wallet -- create alice
//   WALLET_PASSPHRASE=... npm run wallet -- import ./exported-keystore.json alice
//   npm run wallet -- list
//   npm run wallet -- address alice
//   npm run wallet -- balance alice            (or a raw 0x... address)
//   WALLET_PASSPHRASE=... npm run wallet -- send alice bob 10
//
// A thin wrapper around Wallet / WalletStore / NodeClient (src/). Keystores
// use the SAME format as the frontend, so they can be moved back and forth.
//
// NODE_URL selects which node to talk to (default ws://localhost:3000;
// http:// URLs are accepted and treated as ws://).

const store = new WalletStore("wallets");
const client = new NodeClient(); // reads NODE_URL

function requirePassphrase(): string {
  const passphrase = process.env.WALLET_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      "Missing WALLET_PASSPHRASE (used to encrypt/decrypt the wallet private key).",
    );
  }
  return passphrase;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "create": {
      const [name] = args;
      if (!name) return usage();
      if (store.exists(name))
        throw new Error(
          `Wallet "${name}" already exists at ${store.path(name)}`,
        );
      const wallet = Wallet.create(requirePassphrase(), name);
      console.log(`Created ${store.save(name, wallet)}`);
      console.log(`Address: ${wallet.address}`);
      break;
    }

    case "import": {
      const [file, name] = args;
      if (!file || !name) return usage();
      if (!existsSync(file))
        throw new Error(`Keystore file not found: ${file}`);
      if (store.exists(name))
        throw new Error(
          `Wallet "${name}" already exists at ${store.path(name)}`,
        );
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        throw new Error("Keystore is not valid JSON");
      }
      const wallet = Wallet.import(raw, requirePassphrase()); // proves passphrase + integrity
      console.log(`Imported as ${store.save(name, wallet)}`);
      console.log(`Address: ${wallet.address}`);
      break;
    }

    case "list": {
      const names = store.list();
      if (names.length === 0) console.log("(no wallets)");
      for (const n of names) console.log(`${n}  ${store.load(n).address}`);
      break;
    }

    case "address": {
      const [name] = args;
      if (!name) return usage();
      console.log(store.load(name).address);
      break;
    }

    case "balance": {
      const [who] = args;
      if (!who) return usage();
      const account = await client.getAccount(store.resolveAddress(who));
      console.log(JSON.stringify(account, null, 2));
      break;
    }

    case "send": {
      const [fromName, toWho, amountStr] = args;
      if (!fromName || !toWho || !amountStr) return usage();
      if (
        !/^\d+$/.test(amountStr) ||
        !Number.isSafeInteger(Number(amountStr)) ||
        Number(amountStr) <= 0
      ) {
        throw new Error("amount must be a positive integer");
      }

      const wallet = store.load(fromName).unlock(requirePassphrase());
      const tx = await client.send(
        wallet,
        store.resolveAddress(toWho),
        Number(amountStr),
      );
      console.log(`Submitted ${tx.hash}`);
      console.log(
        `${tx.from} -> ${tx.to}  amount ${tx.amount}  nonce ${tx.nonce}`,
      );
      break;
    }

    default:
      usage();
  }
}

function usage(): never {
  console.error(
    "Usage:\n" +
      "  npm run wallet -- create <name>\n" +
      "  npm run wallet -- import <keystore.json> <name>\n" +
      "  npm run wallet -- list\n" +
      "  npm run wallet -- address <name>\n" +
      "  npm run wallet -- balance <name|0xaddress>\n" +
      "  npm run wallet -- send <fromName> <toName|0xaddress> <amount>",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
