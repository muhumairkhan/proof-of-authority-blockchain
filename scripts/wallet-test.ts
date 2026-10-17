import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocketServer } from "ws";
import { Wallet } from "../src/wallet";
import { WalletStore } from "../src/walletStore";
import { NodeClient } from "../src/nodeClient";
import { verifyTransaction } from "../src/transaction";
import { unlockKeystore } from "../src/crypto";

// Run with: npm run test:wallet
// Wallet + WalletStore run offline; NodeClient talks to a mock node on a local port.

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failed++;
}
function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function walletTests() {
  console.log("\nWallet");
  const alice = Wallet.create("pw", "alice");
  const bob = Wallet.create("pw", "bob");

  check(
    "create returns an unlocked wallet with a valid address",
    alice.isUnlocked && /^0x[0-9a-f]{40}$/.test(alice.address),
  );

  const tx = alice.createTransaction(bob.address, 10, 0);
  check(
    "signed transaction passes verifyTransaction",
    verifyTransaction(tx).valid,
  );
  check(
    "transaction has the right fields",
    tx.from === alice.address &&
      tx.to === bob.address &&
      tx.amount === 10 &&
      tx.nonce === 0,
  );

  check(
    "uppercase recipient is normalised",
    alice.createTransaction(bob.address.toUpperCase().replace("0X", "0x"), 1, 0)
      .to === bob.address,
  );
  check(
    "rejects decimal amount",
    throws(() => alice.createTransaction(bob.address, 1.5, 0)) !== null,
  );
  check(
    "rejects zero / negative amount",
    throws(() => alice.createTransaction(bob.address, 0, 0)) !== null &&
      throws(() => alice.createTransaction(bob.address, -1, 0)) !== null,
  );
  check(
    "rejects negative nonce",
    throws(() => alice.createTransaction(bob.address, 1, -1)) !== null,
  );
  check(
    "rejects bad recipient",
    throws(() => alice.createTransaction("0x123", 1, 0)) !== null,
  );
  check(
    "rejects sending to self",
    throws(() => alice.createTransaction(alice.address, 1, 0)) !== null,
  );

  const locked = Wallet.fromKeystore(alice.exportKeystore());
  check(
    "fromKeystore gives a locked wallet that cannot sign",
    !locked.isUnlocked &&
      throws(() => locked.createTransaction(bob.address, 1, 0)) !== null,
  );
  check(
    "locked wallet still knows its address",
    locked.address === alice.address,
  );
  check(
    "wrong passphrase fails to unlock",
    throws(() => locked.unlock("nope")) !== null && !locked.isUnlocked,
  );
  locked.unlock("pw");
  check(
    "correct passphrase unlocks and signs",
    locked.isUnlocked &&
      verifyTransaction(locked.createTransaction(bob.address, 2, 0)).valid,
  );
  locked.lock();
  check(
    "lock() disables signing again",
    !locked.isUnlocked &&
      throws(() => locked.createTransaction(bob.address, 1, 0)) !== null,
  );

  const ks = alice.exportKeystore();
  check(
    "export is standard keystore (round-trips through core unlockKeystore)",
    unlockKeystore(ks, "pw").address === alice.address,
  );
  check(
    "export does not leak a plaintext private key",
    !JSON.stringify(ks).includes("PRIVATE KEY"),
  );
  check(
    "import restores the same address",
    Wallet.import(ks, "pw").address === alice.address,
  );
  check(
    "exportKeystore(name) renames",
    alice.exportKeystore("renamed").name === "renamed",
  );

  check(
    "rejects keystore with missing fields",
    throws(() => Wallet.fromKeystore({})) !== null,
  );
  check(
    "rejects keystore whose address does not match its key",
    throws(() => Wallet.fromKeystore({ ...ks, address: bob.address })) !== null,
  );
  const tampered = {
    ...ks,
    encryptedPrivateKey: {
      ...ks.encryptedPrivateKey,
      ciphertext: ks.encryptedPrivateKey.ciphertext.replace(
        /^../,
        (m: string) => (m === "00" ? "ff" : "00"),
      ),
    },
  };
  check(
    "tampered ciphertext fails to unlock",
    throws(() => Wallet.fromKeystore(tampered).unlock("pw")) !== null,
  );
}

function storeTests() {
  console.log("\nWalletStore");
  const dir = mkdtempSync(join(tmpdir(), "wallet-store-"));
  const store = new WalletStore(join(dir, "wallets"));
  const w = Wallet.create("pw");

  check("list is empty before anything is saved", store.list().length === 0);
  const path = store.save("alice", w);
  check(
    "save writes <name>.json and no leftover .tmp",
    existsSync(path) && !existsSync(path + ".tmp"),
  );
  check(
    "list shows the wallet",
    JSON.stringify(store.list()) === JSON.stringify(["alice"]),
  );
  check(
    "load returns a locked wallet with the same address",
    !store.load("alice").isUnlocked &&
      store.load("alice").address === w.address,
  );
  check(
    "saved keystore carries the chosen name",
    store.load("alice").name === "alice",
  );
  check(
    "saving over an existing wallet is refused",
    throws(() => store.save("alice", w)) !== null,
  );
  check(
    "overwrite: true allows it",
    throws(() => store.save("alice", w, { overwrite: true })) === null,
  );
  check(
    "loaded wallet can sign after unlock",
    verifyTransaction(
      store
        .load("alice")
        .unlock("pw")
        .createTransaction("0x" + "a".repeat(40), 1, 0),
    ).valid,
  );
  check(
    "path traversal in names is refused",
    throws(() => store.load("../secret")) !== null &&
      throws(() => store.save("a/b", w)) !== null,
  );
  check(
    "loading a missing wallet gives a clear error",
    (throws(() => store.load("ghost")) ?? "").includes("No wallet"),
  );
  writeFileSync(join(dir, "wallets", "broken.json"), "{not json");
  check(
    "corrupt file gives a clear error",
    (throws(() => store.load("broken")) ?? "").includes("not valid JSON"),
  );
  check(
    "resolveAddress: name, raw address, and garbage",
    store.resolveAddress("alice") === w.address &&
      store.resolveAddress("0x" + "A".repeat(40)) === "0x" + "a".repeat(40) &&
      throws(() => store.resolveAddress("0xnope")) !== null,
  );
  check(
    "delete removes it",
    store.delete("alice") === true && store.delete("alice") === false,
  );
  rmSync(dir, { recursive: true, force: true });
}

async function clientTests() {
  console.log("\nNodeClient (mock node)");
  const accounts: Record<
    string,
    { balance: number; nonce: number; nextNonce: number }
  > = {};
  const submitted: any[] = [];

  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as any).port;

  wss.on("connection", (ws: any) => {
    ws.on("message", (raw: any) => {
      const { id, method, params } = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ event: "status", data: {} })); // an unrelated push the client must ignore
      if (method === "getAccount") {
        const a = accounts[params.address] ?? {
          balance: 0,
          nonce: 0,
          nextNonce: 0,
        };
        ws.send(
          JSON.stringify({ id, result: { address: params.address, ...a } }),
        );
      } else if (method === "submitTransaction") {
        if (params.transaction.amount > 100) {
          ws.send(
            JSON.stringify({
              id,
              error: { message: "insufficient balance", code: 400 },
            }),
          );
        } else {
          submitted.push(params.transaction);
          ws.send(
            JSON.stringify({
              id,
              result: { success: true, transaction: params.transaction },
            }),
          );
        }
      } else if (method === "hang") {
        // never answer
      } else {
        ws.send(
          JSON.stringify({
            id,
            error: { message: `unknown method "${method}"`, code: 404 },
          }),
        );
      }
    });
  });

  const client = new NodeClient(`ws://localhost:${port}`, 1000);
  const alice = Wallet.create("pw");
  const bob = Wallet.create("pw");
  accounts[alice.address] = { balance: 100, nonce: 2, nextNonce: 4 };

  const acct = await client.getAccount(alice.address);
  check(
    "getAccount returns the node result (pushes ignored)",
    acct.nextNonce === 4 && acct.balance === 100,
  );

  const tx = await client.send(alice, bob.address, 10);
  check("send uses the node's nextNonce", tx.nonce === 4);
  check(
    "node received a valid signed tx",
    submitted.length === 1 && verifyTransaction(submitted[0]).valid,
  );

  let err: any = null;
  try {
    await client.send(alice, bob.address, 500);
  } catch (e) {
    err = e;
  }
  check(
    "node errors surface with message and code",
    err?.message === "insufficient balance" && err?.code === 400,
  );

  err = null;
  try {
    await client.request("nope");
  } catch (e) {
    err = e;
  }
  check("unknown method gives a 404 error", err?.code === 404);

  err = null;
  try {
    await client.request("hang");
  } catch (e) {
    err = e;
  }
  check(
    "unanswered request times out",
    (err?.message ?? "").includes("timed out"),
  );

  err = null;
  try {
    await new NodeClient("ws://localhost:1", 1000).getStatus();
  } catch (e) {
    err = e;
  }
  check(
    "unreachable node gives a clear error",
    (err?.message ?? "").includes("cannot reach"),
  );

  check(
    "http:// URLs are treated as ws://",
    new NodeClient("http://localhost:3000").url === "ws://localhost:3000",
  );

  wss.close();
}

(async () => {
  walletTests();
  storeTests();
  await clientTests();
  console.log(
    failed === 0 ? "\nALL WALLET CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
})();
