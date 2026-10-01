import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Peer table: the set of P2P addresses this node knows about, with just
 * enough health info to decide who to keep dialing.
 *
 *   lastSeen > 0   -> we completed a handshake with this address ("verified")
 *   failures       -> consecutive failed dials since the last success
 *
 * Only verified, currently-healthy addresses are ever shared with other
 * nodes (see verified()). Unverified addresses (learned from a peer's
 * gossip or an inbound HELLO) are just candidates until we dial them
 * ourselves and the handshake succeeds.
 */
export interface PeerEntry {
  address: string;
  lastSeen: number;
  failures: number;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Canonical form: ws://host:port, with every loopback spelling collapsed to "localhost". */
export function normalizeAddress(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  const port = Number(url.port);
  if (!url.port || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!url.hostname) return null;
  const host = LOOPBACK.has(url.hostname) ? 'localhost' : url.hostname;
  return `${url.protocol}//${host}:${port}`;
}

/**
 * Builds a dialable address from an inbound socket's remote IP plus the port
 * the peer announced in its HELLO (an inbound socket's own port is just an
 * ephemeral outbound port and tells us nothing about where it listens).
 */
export function addressFromRemote(remoteIp: string | undefined, port: number): string | null {
  if (!remoteIp || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const ip = remoteIp.replace(/^::ffff:/i, ''); // IPv4-mapped IPv6
  const host = LOOPBACK.has(ip) ? 'localhost' : ip.includes(':') ? `[${ip}]` : ip;
  return normalizeAddress(`ws://${host}:${port}`);
}

export interface PeerTableOptions {
  filePath?: string; // where to persist; omit for in-memory only
  bootnodes?: string[]; // never dropped for failures
  maxFailures?: number; // consecutive failed dials before a non-bootnode is dropped
  maxSize?: number; // cap on table size so gossip can't grow it unbounded
}

export class PeerTable {
  private entries = new Map<string, PeerEntry>();
  private bootnodes = new Set<string>();
  private blocked = new Set<string>(); // self / incompatible addresses: never re-added
  private filePath?: string;
  private maxFailures: number;
  private maxSize: number;

  constructor(opts: PeerTableOptions = {}) {
    this.filePath = opts.filePath;
    this.maxFailures = opts.maxFailures ?? 10;
    this.maxSize = opts.maxSize ?? 200;

    for (const raw of opts.bootnodes ?? []) {
      const address = normalizeAddress(raw);
      if (!address) continue;
      this.bootnodes.add(address);
      this.entries.set(address, { address, lastSeen: 0, failures: 0 });
    }
    this.load();
  }

  // --- reads ---------------------------------------------------------------

  all(): PeerEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  get(address: string): PeerEntry | undefined {
    const e = this.entries.get(address);
    return e ? { ...e } : undefined;
  }

  has(address: string): boolean {
    return this.entries.has(address);
  }

  isBootnode(address: string): boolean {
    return this.bootnodes.has(address);
  }

  isBlocked(address: string): boolean {
    return this.blocked.has(address);
  }

  /** Addresses safe to hand to other nodes: handshaken before and not currently failing. */
  verified(): string[] {
    return [...this.entries.values()]
      .filter((e) => e.lastSeen > 0 && e.failures === 0)
      .map((e) => e.address);
  }

  // --- writes --------------------------------------------------------------

  /** Adds an unverified candidate. Returns false if invalid, known, blocked, or the table is full. */
  add(raw: string): boolean {
    const address = normalizeAddress(raw);
    if (!address || this.blocked.has(address) || this.entries.has(address)) return false;
    if (this.entries.size >= this.maxSize) return false;
    this.entries.set(address, { address, lastSeen: 0, failures: 0 });
    this.persist();
    return true;
  }

  /** Marks a completed handshake. Returns true if this is the FIRST time the address became verified. */
  recordSuccess(address: string, now = Date.now()): boolean {
    const entry = this.entries.get(address);
    if (!entry) return false;
    const firstTime = entry.lastSeen === 0;
    entry.lastSeen = now;
    entry.failures = 0;
    this.persist();
    return firstTime;
  }

  /** Counts a failed dial. Non-bootnodes are dropped after maxFailures in a row. */
  recordFailure(address: string): { dropped: boolean } {
    const entry = this.entries.get(address);
    if (!entry) return { dropped: false };
    entry.failures++;
    if (entry.failures >= this.maxFailures && !this.bootnodes.has(address)) {
      this.entries.delete(address);
      this.persist();
      return { dropped: true };
    }
    return { dropped: false };
  }

  /** Permanently refuse an address (self, wrong genesis/params). Removes it even if it's a bootnode. */
  block(raw: string): void {
    const address = normalizeAddress(raw);
    if (!address) return;
    this.blocked.add(address);
    if (this.entries.delete(address)) this.persist();
  }

  // --- persistence ---------------------------------------------------------

  private load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (!Array.isArray(raw?.peers)) return;
      for (const p of raw.peers) {
        const address = typeof p?.address === 'string' ? normalizeAddress(p.address) : null;
        if (!address || this.blocked.has(address)) continue;
        const lastSeen = Number.isFinite(p.lastSeen) ? p.lastSeen : 0;
        const existing = this.entries.get(address);
        if (existing) {
          existing.lastSeen = lastSeen; // bootnode already present: just restore its history
        } else if (this.entries.size < this.maxSize) {
          this.entries.set(address, { address, lastSeen, failures: 0 });
        }
      }
    } catch (err) {
      console.error(`[peers] Failed to read ${this.filePath}, starting fresh: ${(err as Error).message}`);
    }
  }

  private persist() {
    if (!this.filePath) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // temp file + rename so a crash never leaves a half-written file
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ peers: this.all() }, null, 2));
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(`[peers] Failed to persist ${this.filePath}: ${(err as Error).message}`);
    }
  }
}