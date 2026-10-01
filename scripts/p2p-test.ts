import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { Blockchain } from '../src/blockchain';
import { ValidatorSet } from '../src/validatorSet';
import { P2PNode } from '../src/p2p';
import { PeerTable, normalizeAddress, addressFromRemote } from '../src/peerTable';

// Run with: npm run test:p2p        (VERBOSE=1 to see node logs)
//
// Part 1: PeerTable rules (pure, instant).
// Part 2: real nodes in one process talking over real WebSockets.

const VERBOSE = !!process.env.VERBOSE;
if (!VERBOSE) {
  console.log = console.debug = console.warn = console.error = () => {};
}
const out = (s = '') => process.stdout.write(s + '\n');

let failed = 0;
function check(label: string, ok: boolean, detail = '') {
  out(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

// ---------------------------------------------------------------------------
// Part 1: PeerTable
// ---------------------------------------------------------------------------
function unitTests() {
  out('\nPeerTable / address helpers');

  check('normalizes loopback spellings', normalizeAddress('ws://127.0.0.1:6000') === 'ws://localhost:6000' && normalizeAddress('ws://[::1]:6000') === 'ws://localhost:6000');
  check('rejects non-ws, missing port, bad port',
    normalizeAddress('http://x:1') === null && normalizeAddress('ws://host') === null && normalizeAddress('ws://host:99999') === null && normalizeAddress('nonsense') === null);
  check('addressFromRemote maps IPv4-mapped loopback', addressFromRemote('::ffff:127.0.0.1', 6001) === 'ws://localhost:6001');
  check('addressFromRemote keeps real IPs', addressFromRemote('10.0.0.5', 6001) === 'ws://10.0.0.5:6001');
  check('addressFromRemote rejects bad port', addressFromRemote('10.0.0.5', 0) === null && addressFromRemote(undefined, 6001) === null);

  const t = new PeerTable({ bootnodes: ['ws://localhost:6000'], maxFailures: 3, maxSize: 4 });
  check('bootnode is in the table, unverified', t.has('ws://localhost:6000') && t.verified().length === 0);
  check('add: new address accepted', t.add('ws://localhost:6001') === true);
  check('add: duplicate / invalid refused', t.add('ws://127.0.0.1:6001') === false && t.add('garbage') === false);
  check('recordSuccess reports first verification once',
    t.recordSuccess('ws://localhost:6001') === true && t.recordSuccess('ws://localhost:6001') === false);
  check('verified() lists only handshaken peers', JSON.stringify(t.verified()) === JSON.stringify(['ws://localhost:6001']));

  t.recordFailure('ws://localhost:6001');
  check('a failing peer is not shared (failures > 0)', t.verified().length === 0);
  t.recordSuccess('ws://localhost:6001');
  check('success resets failures', t.verified().length === 1);

  t.add('ws://localhost:6002');
  t.recordFailure('ws://localhost:6002');
  t.recordFailure('ws://localhost:6002');
  check('non-bootnode dropped after maxFailures', t.recordFailure('ws://localhost:6002').dropped === true && !t.has('ws://localhost:6002'));

  for (let i = 0; i < 5; i++) t.recordFailure('ws://localhost:6000');
  check('bootnode is never dropped', t.has('ws://localhost:6000'));

  // table now holds 6000 (bootnode) + 6001; fill it to maxSize (4), then one more must be refused
  t.add('ws://localhost:6003');
  t.add('ws://localhost:6004');
  check('maxSize caps the table', t.all().length === 4 && t.add('ws://localhost:6005') === false);

  t.block('ws://localhost:6000');
  check('block() removes even a bootnode and refuses re-adding', !t.has('ws://localhost:6000') && t.add('ws://localhost:6000') === false);

  const dir = mkdtempSync(join(tmpdir(), 'peertable-'));
  const file = join(dir, 'peers.json');
  const a = new PeerTable({ filePath: file });
  a.add('ws://localhost:7001');
  a.recordSuccess('ws://localhost:7001', 12345);
  const b = new PeerTable({ filePath: file });
  check('persists to disk and reloads', b.get('ws://localhost:7001')?.lastSeen === 12345);
  check('no leftover .tmp file', !existsSync(file + '.tmp'));
  writeFileSync(file, '{not json');
  check('corrupt file is ignored, not fatal', new PeerTable({ filePath: file }).all().length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 2: real nodes
// ---------------------------------------------------------------------------
const nodes: P2PNode[] = [];

function makeNode(port: number, bootnodes: string[], opts: { slotDurationMs?: number; filePath?: string } = {}) {
  const chain = new Blockchain(new ValidatorSet(['test-validator']), undefined, opts.slotDurationMs ?? 15000, 3000);
  const table = new PeerTable({ bootnodes, filePath: opts.filePath });
  const p2p = new P2PNode(chain, port, table);
  p2p.start();
  nodes.push(p2p);
  return { p2p, table };
}
const addr = (port: number) => `ws://localhost:${port}`;
const connectedCount = (n: { p2p: P2PNode }) => n.p2p.getPeerInfo().connected.length;
const connectedTo = (n: { p2p: P2PNode }, port: number) =>
  n.p2p.getPeerInfo().connected.some((c) => c.address === addr(port));

async function integrationTests() {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-test-'));

  // --- mesh via a single bootnode ------------------------------------------
  out('\nMesh forms from one bootnode (B and C only know A)');
  const A = makeNode(18100, []);
  const B = makeNode(18101, [addr(18100)]);
  await sleep(300);
  const C = makeNode(18102, [addr(18100)], { filePath: join(dir, 'c-peers.json') });

  const meshed = await waitFor(() => [A, B, C].every((n) => connectedCount(n) === 2), 15000);
  check('every node ends up connected to the other two', meshed,
    `A=${connectedCount(A)} B=${connectedCount(B)} C=${connectedCount(C)}`);
  check('C discovered B through A (never configured)', connectedTo(C, 18101) && C.table.has(addr(18101)));
  check('B discovered C (C dialed B, B dialed back)', connectedTo(B, 18102) && B.table.verified().includes(addr(18102)));

  await sleep(3000);
  check('no duplicate connections after settling', [A, B, C].every((n) => connectedCount(n) === 2),
    `A=${connectedCount(A)} B=${connectedCount(B)} C=${connectedCount(C)}`);

  // --- restart without a bootnode ------------------------------------------
  out('\nRestart uses the saved peer table (no bootnodes configured)');
  C.p2p.stop();
  await sleep(500);
  const C2 = makeNode(18102, [], { filePath: join(dir, 'c-peers.json') });
  const back = await waitFor(() => connectedCount(C2) === 2, 12000);
  check('restarted node reconnects to A and B from disk alone', back, `connected=${connectedCount(C2)}`);

  // --- incompatible node ---------------------------------------------------
  out('\nIncompatible node is refused');
  const D = makeNode(18103, [addr(18100)], { slotDurationMs: 9999 });
  await sleep(4000);
  check('mismatched node has no connections', connectedCount(D) === 0);
  check('mismatched node stops retrying the bootnode (blocked)', !D.table.has(addr(18100)));
  check('network did not accept it', !A.table.has(addr(18103)) && !connectedTo(A, 18103));
  D.p2p.stop();

  // --- self in bootnode list -----------------------------------------------
  out('\nNode never dials itself');
  const H = makeNode(18106, [addr(18106), addr(18100)]);
  const joined = await waitFor(() => connectedTo(H, 18100), 8000);
  check('self address removed from the table', !H.table.has(addr(18106)));
  check('still joins the network through the real bootnode', joined);

  // --- simultaneous dial ---------------------------------------------------
  out('\nTwo nodes dialing each other at the same moment');
  const E = makeNode(18104, [addr(18105)]);
  const F = makeNode(18105, [addr(18104)]);
  const paired = await waitFor(() => connectedCount(E) >= 1 && connectedCount(F) >= 1, 10000);
  check('they connect', paired);
  await sleep(6000);
  check('exactly one connection each (not two)', connectedCount(E) === 1 && connectedCount(F) === 1,
    `E=${connectedCount(E)} F=${connectedCount(F)}`);

  // --- hostile / sloppy client --------------------------------------------
  out('\nMessages before the handshake are ignored');
  const gotChain = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(addr(18100));
    let sawChainResponse = false;
    ws.on('open', () => {
      ws.send('this is not json');
      ws.send(JSON.stringify({ type: 'CHAIN_REQUEST' })); // would normally return the chain
      ws.send(JSON.stringify(null));
    });
    ws.on('message', (raw) => {
      try {
        if (JSON.parse(raw.toString()).type === 'CHAIN_RESPONSE') sawChainResponse = true;
      } catch {}
    });
    ws.on('error', () => {});
    setTimeout(() => {
      ws.terminate();
      resolve(sawChainResponse);
    }, 1200);
  });
  check('no CHAIN_RESPONSE for a socket that never said HELLO', !gotChain);
  check('node survived garbage input', connectedCount(A) >= 2);

  for (const n of nodes) n.stop();
  rmSync(dir, { recursive: true, force: true });
}

(async () => {
  unitTests();
  await integrationTests();
  out(failed === 0 ? '\nALL P2P CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();