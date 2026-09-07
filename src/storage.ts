import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
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
    // Write to a temp file then rename, so a crash mid-write can't corrupt the data file.
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
    writeFileSync(filePath, readFileSync(tmpPath));
  } catch (err) {
    console.error(`[storage] Failed to persist chain to ${filePath}: ${(err as Error).message}`);
  }
}