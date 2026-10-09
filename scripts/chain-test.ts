import { Blockchain } from "../src/blockchain";
import { Block } from "../src/block";
import { ValidatorSet } from "../src/validatorSet";
import {
  generateValidatorKeyPair,
  addressFromPublicKey,
  KeyPair,
} from "../src/crypto";
import { createSignedTransaction } from "../src/transaction";
import { Transaction } from "../src/types";

// Run with: npm run test:chain
//
// Tests the consensus rules directly on Blockchain (no network, no disk).
// Blocks are built with explicit timestamps aligned to slot boundaries, in
// the past, so results never depend on the real clock — except the
// future-timestamp test, which deliberately uses a far-future time.

const SLOT = 15000;
const WAIT = 3000;
const BASE = Math.floor(Date.now() / SLOT) - 1000; // a slot well in the past

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failed++;
}

// --- fixtures ----------------------------------------------------------------

const validators: KeyPair[] = [
  generateValidatorKeyPair(),
  generateValidatorKeyPair(),
];

interface Wallet extends KeyPair {
  address: string;
}
function makeWallet(): Wallet {
  const kp = generateValidatorKeyPair();
  return { ...kp, address: addressFromPublicKey(kp.publicKey) };
}

function makeChain(allocations: Record<string, number> = {}) {
  return new Blockchain(
    new ValidatorSet(validators.map((v) => v.publicKey)),
    undefined, // no persistence
    SLOT,
    WAIT,
    allocations,
  );
}

function ownerKey(chain: Blockchain, slot: number): KeyPair {
  const pk = chain.validatorSet.getValidatorForSlot(slot);
  return validators.find((v) => v.publicKey === pk)!;
}

function buildBlock(
  chain: Blockchain,
  slot: number,
  txs: Transaction[] = [],
  opts: { timestamp?: number; signer?: KeyPair } = {},
): Block {
  const latest = chain.getLatestBlock();
  const signer = opts.signer ?? ownerKey(chain, slot);
  return Block.proposeBlock(
    {
      index: latest.index + 1,
      timestamp: opts.timestamp ?? slot * SLOT + WAIT + 100,
      transactions: txs,
      previousHash: latest.hash,
      validatorPublicKey: signer.publicKey,
    },
    signer.privateKey,
  );
}

function makeTx(
  from: Wallet,
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

const includes = (reason: string | undefined, text: string) =>
  (reason ?? "").includes(text);

// --- tests -------------------------------------------------------------------

function blockRules() {
  console.log("\nBlock rules");
  const alice = makeWallet();
  const bob = makeWallet();
  const chain = makeChain({ [alice.address]: 100 });

  // wrong validator
  const nonOwner = validators.find((v) => v !== ownerKey(chain, BASE))!;
  let r = chain.addBlock(
    buildBlock(chain, BASE, [makeTx(alice, bob.address, 10, 0)], {
      signer: nonOwner,
    }),
  );
  check(
    "block from the wrong validator is rejected",
    !r.success && includes(r.reason, "assigned"),
    r.reason,
  );

  // wait window
  r = chain.addBlock(
    buildBlock(chain, BASE, [makeTx(alice, bob.address, 10, 0)], {
      timestamp: BASE * SLOT + 100,
    }),
  );
  check(
    "block inside the slot wait window is rejected",
    !r.success && includes(r.reason, "wait"),
    r.reason,
  );

  // valid block
  r = chain.addBlock(
    buildBlock(chain, BASE, [makeTx(alice, bob.address, 10, 0)]),
  );
  check("valid block from the slot owner is accepted", r.success, r.reason);
  check(
    "balances updated after block",
    chain.getAccount(alice.address).balance === 90 &&
      chain.getAccount(bob.address).balance === 10,
  );

  // slot reuse
  r = chain.addBlock(
    buildBlock(chain, BASE, [makeTx(alice, bob.address, 5, 1)], {
      timestamp: BASE * SLOT + WAIT + 200,
    }),
  );
  check(
    "second block in an already-used slot is rejected",
    !r.success && includes(r.reason, "slot"),
    r.reason,
  );

  // future timestamp (needs the isValidNewBlock future-drift check)
  const futureSlot = Math.floor((Date.now() + 3_600_000) / SLOT);
  r = chain.addBlock(
    buildBlock(chain, futureSlot, [makeTx(alice, bob.address, 5, 1)]),
  );
  check(
    "block timestamped far in the future is rejected",
    !r.success && includes(r.reason, "future"),
    r.reason ?? "accepted!",
  );

  // bad block links
  const good = buildBlock(chain, BASE + 1, [makeTx(alice, bob.address, 5, 1)]);
  const tampered = Block.fromPlain({ ...good, previousHash: "f".repeat(64) });
  r = chain.addBlock(tampered);
  check("block with wrong previousHash is rejected", !r.success, r.reason);

  r = chain.addBlock(good);
  check("a correct block still goes through afterwards", r.success, r.reason);
}

function transactionRules() {
  console.log("\nTransactions inside blocks");
  const alice = makeWallet();
  const bob = makeWallet();
  const chain = makeChain({ [alice.address]: 100 });

  chain.addBlock(buildBlock(chain, BASE, [makeTx(alice, bob.address, 10, 0)]));

  let r = chain.addBlock(
    buildBlock(chain, BASE + 1, [makeTx(alice, bob.address, 10, 0)]),
  );
  check(
    "reused nonce is rejected",
    !r.success && includes(r.reason, "nonce"),
    r.reason,
  );

  r = chain.addBlock(
    buildBlock(chain, BASE + 1, [makeTx(alice, bob.address, 1_000_000, 1)]),
  );
  check(
    "insufficient balance is rejected",
    !r.success && includes(r.reason, "insufficient"),
    r.reason,
  );

  const forged = makeTx(alice, bob.address, 10, 1);
  forged.amount = 90; // changed after signing
  r = chain.addBlock(buildBlock(chain, BASE + 1, [forged]));
  check(
    "tx tampered after signing is rejected",
    !r.success && includes(r.reason, "invalid transaction"),
    r.reason,
  );

  const mallory = makeWallet();
  const stolen = createSignedTransaction(
    {
      from: alice.address,
      to: bob.address,
      amount: 10,
      nonce: 1,
      timestamp: Date.now(),
    },
    mallory.publicKey, // someone else's key claiming alice's address
    mallory.privateKey,
  );
  r = chain.addBlock(buildBlock(chain, BASE + 1, [stolen]));
  check(
    "tx signed by a key that does not own the sender address is rejected",
    !r.success,
    r.reason,
  );

  // rejected blocks must not change state
  check(
    "rejected blocks left state untouched",
    chain.getAccount(alice.address).balance === 90,
  );

  r = chain.addBlock(
    buildBlock(chain, BASE + 1, [makeTx(alice, bob.address, 10, 1)]),
  );
  check("valid next-nonce tx is accepted", r.success, r.reason);

  // mempool
  const mp = makeChain({ [alice.address]: 100 });
  check(
    "mempool accepts a valid tx",
    mp.addTransaction(makeTx(alice, bob.address, 10, 0)).added,
  );
  const dup = mp.addTransaction(makeTx(alice, bob.address, 20, 0));
  check(
    "mempool refuses a second tx with the same nonce",
    !dup.added,
    dup.reason,
  );
}

function chainReplacement() {
  console.log("\nreplaceChain");
  const alice = makeWallet();
  const bob = makeWallet();
  const alloc = { [alice.address]: 100 };

  const source = makeChain(alloc);
  source.addBlock(
    buildBlock(source, BASE, [makeTx(alice, bob.address, 10, 0)]),
  );
  source.addBlock(
    buildBlock(source, BASE + 1, [makeTx(alice, bob.address, 10, 1)]),
  );
  check(
    "source chain built (3 blocks incl. genesis)",
    source.chain.length === 3,
  );

  const target = makeChain(alloc);
  const res = target.replaceChain(source.chain);
  check(
    "a longer valid chain replaces a shorter one",
    res.replaced,
    res.reason,
  );
  check(
    "state is rebuilt from the replacement",
    target.getAccount(bob.address).balance === 20,
  );

  const tamperedCopy = JSON.parse(JSON.stringify(source.chain));
  tamperedCopy[2].transactions[0].amount = 99;
  const res2 = makeChain(alloc).replaceChain(tamperedCopy);
  check("a longer but tampered chain is rejected", !res2.replaced, res2.reason);

  const res3 = target.replaceChain(source.chain);
  check("an equal-length chain is not adopted", !res3.replaced);
}

function genesisCommitment() {
  console.log("\nGenesis commits to config");
  const alice = makeWallet();
  const bob = makeWallet();

  const a = makeChain({ [alice.address]: 100 });
  const b = makeChain({ [alice.address]: 999 });
  check(
    "different allocations give different genesis hashes",
    a.chain[0].hash !== b.chain[0].hash,
  );

  const same = makeChain({ [alice.address]: 100 });
  check(
    "same config gives the same genesis hash",
    a.chain[0].hash === same.chain[0].hash,
  );

  const reordered = makeChain({ [bob.address]: 5, [alice.address]: 100 });
  const reordered2 = makeChain({ [alice.address]: 100, [bob.address]: 5 });
  check(
    "allocation key order does not change the hash",
    reordered.chain[0].hash === reordered2.chain[0].hash,
  );

  const otherValidators = new Blockchain(
    new ValidatorSet([validators[1].publicKey, validators[0].publicKey]),
    undefined,
    SLOT,
    WAIT,
    {
      [alice.address]: 100,
    },
  );
  check(
    "different validator order gives a different genesis hash",
    a.chain[0].hash !== otherValidators.chain[0].hash,
  );

  const source = makeChain({ [alice.address]: 100 });
  source.addBlock(
    buildBlock(source, BASE, [makeTx(alice, bob.address, 10, 0)]),
  );
  const res = b.replaceChain(source.chain);
  check(
    "chain from a different genesis config is rejected",
    !res.replaced && includes(res.reason, "genesis"),
    res.reason,
  );
}

blockRules();
transactionRules();
chainReplacement();
genesisCommitment();

console.log(
  failed === 0 ? "\nALL CHAIN CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
