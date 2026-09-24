import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

export interface ChainSnapshot {
  chain: any[];
  pendingTransactions: any[];
}

export function loadSnapshot(filePath: string): ChainSnapshot | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(raw.chain) || raw.chain.length === 0) return null;
    return {
      chain: raw.chain,
      pendingTransactions: Array.isArray(raw.pendingTransactions) ? raw.pendingTransactions : [],
    };
  } catch (err) {
    console.error(`[storage] Failed to read ${filePath}, starting fresh: ${(err as Error).message}`);
    return null;
  }
}

export function saveSnapshot(filePath: string, snapshot: ChainSnapshot): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Write the full snapshot to a temp file first, then atomically rename
    // it into place. A rename (on the same filesystem) either completes
    // fully or not at all from the OS's point of view — there's no
    // intermediate state where filePath contains a half-written file, even
    // if the process crashes or is killed mid-write. Writing directly to
    // filePath (or writing to it a second time) doesn't have this
    // guarantee.
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[storage] Failed to persist chain to ${filePath}: ${(err as Error).message}`);
  }
}