import { appendJsonLine, lineCount, readJsonLines } from '../shared/atomic.js';
import type { LedgerEntry } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

export async function appendLedger(paths: RunPaths, entry: LedgerEntry): Promise<number> {
  await appendJsonLine(paths.ledger, entry);
  return lineCount(paths.ledger);
}

export async function readLedger(paths: RunPaths): Promise<LedgerEntry[]> {
  return readJsonLines<LedgerEntry>(paths.ledger);
}

export function lastAccepted(entries: LedgerEntry[]): LedgerEntry | undefined {
  return [...entries].reverse().find((entry) => entry.status === 'keep');
}
