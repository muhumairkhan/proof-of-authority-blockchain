import { Blockchain, MempoolOptions } from "../src/blockchain";
import { ValidatorSet } from "../src/validatorSet";
import {
  generateValidatorKeyPair,
  addressFromPublicKey,
  KeyPair,
} from "../src/crypto";
import { createSignedTransaction } from "../src/transaction";
import { Transaction } from "../src/types";

// Run with: npm run test:mempool
// Mempool policy (limits, cumulative balance, expiry). Offline, no disk.

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failed++;
}
const includes = (r: string | undefined, t: string) => (r ?? "").includes(t);

interface TestWallet extends KeyPair {
  address: string;
}
function makeWallet(): TestWallet {
  const kp = generateValidatorKeyPair();
  return { ...kp, address: addressFromPublicKey(kp.publicKey) };
}
function makeTx(
  from: TestWallet,
  to: string,
  amount: number,
  nonce: number,
): Transaction {
  return createSignedTransaction(
    { from: from.address, to, amount, nonce, timestamp: Date.now() },
    from.publicKey,
    from.privateKey,
  );
}

const validator = generateValidatorKeyPair();
function makeChain(
  alloc: Record<string, number>,
  opts: Partial<MempoolOptions> = {},
) {
  return new Blockchain(
    new ValidatorSet([validator.publicKey]),
    undefined,
    15000,
    3000,
    alloc,
    opts,
  );
}

const alice = makeWallet();
const bob = makeWallet();
const carol = makeWallet();

console.log("\nMempool limits");

{
  const c = makeChain({ [alice.address]: 1000 }, { maxPendingPerSender: 3 });
  const rs = [0, 1, 2].map((n) =>
    c.addTransaction(makeTx(alice, bob.address, 1, n)),
  );
  check(
    "txs up to the per-sender cap are accepted",
    rs.every((r) => r.added),
  );
  const r = c.addTransaction(makeTx(alice, bob.address, 1, 3));
  check(
    "tx beyond the per-sender cap is rejected",
    !r.added && includes(r.reason, "too many"),
    r.reason,
  );
}

{
  const c = makeChain({ [alice.address]: 1000 }, { maxPendingPerSender: 10 });
  const r = c.addTransaction(makeTx(alice, bob.address, 1, 10));
  check(
    "nonce far ahead of the confirmed nonce is rejected",
    !r.added && includes(r.reason, "far"),
    r.reason,
  );
  check(
    "nonce inside the window is accepted",
    c.addTransaction(makeTx(alice, bob.address, 1, 9)).added,
  );
}

{
  const c = makeChain({ [alice.address]: 100 });
  check(
    "first 60 of 100 is accepted",
    c.addTransaction(makeTx(alice, bob.address, 60, 0)).added,
  );
  const r = c.addTransaction(makeTx(alice, bob.address, 60, 1));
  check(
    "second 60 is rejected (cumulative balance)",
    !r.added && includes(r.reason, "insufficient"),
    r.reason,
  );
  check(
    "a 40 that still fits is accepted",
    c.addTransaction(makeTx(alice, bob.address, 40, 1)).added,
  );
}

{
  const c = makeChain(
    { [alice.address]: 100, [bob.address]: 100, [carol.address]: 100 },
    { maxPoolSize: 2 },
  );
  c.addTransaction(makeTx(alice, carol.address, 1, 0));
  c.addTransaction(makeTx(bob, carol.address, 1, 0));
  const r = c.addTransaction(makeTx(carol, alice.address, 1, 0));
  check(
    "pool refuses new txs when full",
    !r.added && includes(r.reason, "full"),
    r.reason,
  );
}

{
  const c = makeChain({ [alice.address]: 100 });
  const tx = makeTx(alice, bob.address, 5, 0);
  c.addTransaction(tx);
  const r = c.addTransaction(tx);
  check(
    "duplicate tx is rejected",
    !r.added && includes(r.reason, "duplicate"),
    r.reason,
  );
}

{
  const c = makeChain({ [alice.address]: 1000 }, { maxTxsPerBlock: 2 });
  for (let n = 0; n < 5; n++)
    c.addTransaction(makeTx(alice, bob.address, 1, n));
  const sel = c.selectTransactionsForBlock();
  check(
    "block selection is capped, lowest nonces first",
    sel.length === 2 && sel[0].nonce === 0 && sel[1].nonce === 1,
    `got ${sel.length}`,
  );
}

console.log("\nMempool expiry");

{
  let clock = 1_000_000;
  const c = makeChain(
    { [alice.address]: 100 },
    { txTtlMs: 1000, now: () => clock },
  );
  c.addTransaction(makeTx(alice, bob.address, 5, 0));
  let pendingEvents = 0;
  c.on("pending", () => pendingEvents++);

  clock += 500;
  check(
    "sweep keeps a fresh tx",
    c.sweepMempool() === 0 && c.pendingTransactions.length === 1,
  );

  clock += 1000;
  const removed = c.sweepMempool();
  check(
    "sweep removes an expired tx",
    removed === 1 && c.pendingTransactions.length === 0,
  );
  check(
    "sweep emits 'pending' when something was removed",
    pendingEvents === 1,
  );
  check(
    "sweep is quiet when nothing changed",
    c.sweepMempool() === 0 && pendingEvents === 1,
  );
}

console.log(
  failed === 0 ? "\nALL MEMPOOL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
