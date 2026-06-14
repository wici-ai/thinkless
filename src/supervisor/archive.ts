import { atomicWriteFile, atomicWriteJson, readJsonFileMaybe } from '../shared/atomic.js';
import type { ArchiveEntry, ArchiveState, LedgerEntry } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

export interface SelectedArchiveParent {
  entry: ArchiveEntry;
  archiveSize: number;
  nonBest: boolean;
}

export async function recordAcceptedArchiveEntry(paths: RunPaths, ledgerEntry: LedgerEntry, archiveCommit: string, perfCommit: string): Promise<ArchiveState> {
  const state = await loadArchive(paths);
  const entry: ArchiveEntry = {
    ledger_id: ledgerEntry.id,
    ts: new Date().toISOString(),
    kind: 'accepted',
    step_id: ledgerEntry.step_id,
    commit: archiveCommit,
    perf_commit: perfCommit,
    metric: ledgerEntry.metric,
    delta_pct: ledgerEntry.delta_pct,
    parent_id: ledgerEntry.parent_id ?? null,
    branch_count: 0
  };
  const entries = [...state.entries.filter((item) => item.ledger_id !== entry.ledger_id), entry].sort((a, b) => ledgerNumber(a.ledger_id) - ledgerNumber(b.ledger_id));
  const next = { version: state.version + 1, entries };
  await atomicWriteJson(paths.archive, next);
  return next;
}

export async function selectArchiveParent(paths: RunPaths, bestCommit: string): Promise<SelectedArchiveParent | null> {
  const state = await loadArchive(paths);
  const accepted = state.entries.filter((entry) => entry.kind === 'accepted' && entry.commit);
  if (accepted.length === 0) return null;

  const requested = process.env.WICI_ARCHIVE_PARENT;
  const selected =
    (requested ? accepted.find((entry) => entry.ledger_id === requested || entry.commit.startsWith(requested)) : undefined) ??
    accepted
      .filter((entry) => !isBestEntry(entry, bestCommit))
      .sort((a, b) => (a.branch_count ?? 0) - (b.branch_count ?? 0) || ledgerNumber(a.ledger_id) - ledgerNumber(b.ledger_id))[0] ??
    accepted.sort((a, b) => (a.branch_count ?? 0) - (b.branch_count ?? 0) || ledgerNumber(b.ledger_id) - ledgerNumber(a.ledger_id))[0];
  if (!selected) return null;

  const next: ArchiveState = {
    version: state.version + 1,
    entries: state.entries.map((entry) =>
      entry.ledger_id === selected.ledger_id
        ? {
            ...entry,
            branch_count: (entry.branch_count ?? 0) + 1,
            last_branched_at: new Date().toISOString()
          }
        : entry
    )
  };
  await atomicWriteJson(paths.archive, next);
  return {
    entry: next.entries.find((entry) => entry.ledger_id === selected.ledger_id)!,
    archiveSize: accepted.length,
    nonBest: !isBestEntry(selected, bestCommit)
  };
}

export async function restoreLedgerFile(paths: RunPaths, ledger: LedgerEntry[]): Promise<void> {
  await atomicWriteFile(paths.ledger, ledger.length > 0 ? `${ledger.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '');
}

export async function loadArchive(paths: RunPaths): Promise<ArchiveState> {
  const existing = await readJsonFileMaybe<ArchiveState>(paths.archive);
  if (!existing) return { version: 1, entries: [] };
  return {
    version: existing.version,
    entries: existing.entries.map((entry) => ({
      ...entry,
      branch_count: entry.branch_count ?? 0
    }))
  };
}

function ledgerNumber(id: string): number {
  const match = /^iter-(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function isBestEntry(entry: ArchiveEntry, bestCommit: string): boolean {
  return entry.commit === bestCommit || entry.perf_commit === bestCommit;
}
