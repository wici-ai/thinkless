import { atomicWriteJson, readJsonFileMaybe } from '../shared/atomic.js';
import type { AvenueState, AvenueStat, LedgerEntry, WiCiConfig } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

export interface SelectedAvenue {
  name: string;
  state: AvenueState;
  sample: number;
}

export async function selectAvenue(paths: RunPaths, config: WiCiConfig, parentId: string | null = null): Promise<SelectedAvenue> {
  const state = await loadAvenueState(paths, config);
  const rng = thompsonRng();
  const sampled = state.stats
    .map((stat) => {
      const successes = stat.successes ?? 0;
      const failures = stat.failures ?? 0;
      const sample = betaSample(successes + 1, failures + 1, rng) + Math.max(0, stat.downstream_delta_pct ?? 0) * 0.05;
      return { stat, sample };
    })
    .sort((a, b) => b.sample - a.sample || a.stat.selected - b.stat.selected || a.stat.name.localeCompare(b.stat.name));
  const selected = sampled[0];
  if (!selected) {
    throw new Error('No optimization avenues configured');
  }

  const next: AvenueState = {
    version: state.version + 1,
    stats: state.stats.map((item) =>
      item.name === selected.stat.name
        ? {
            ...item,
            selected: item.selected + 1,
            last_selected_at: new Date().toISOString(),
            last_parent_id: parentId,
            last_sample: Number(selected.sample.toFixed(6))
          }
        : item
    )
  };
  await atomicWriteJson(paths.avenues, next);
  return { name: selected.stat.name, state: next, sample: selected.sample };
}

export async function loadAvenueState(paths: RunPaths, config: WiCiConfig): Promise<AvenueState> {
  const existing = await readJsonFileMaybe<AvenueState>(paths.avenues);
  const names = config.diversity.avenues.length > 0 ? config.diversity.avenues : ['algorithmic complexity'];
  if (!existing) {
    return {
      version: 1,
      stats: names.map((name) => normalizeStat({ name, selected: 0 }))
    };
  }

  const seen = new Set(existing.stats.map((item) => item.name));
  return {
    version: existing.version,
    stats: [...existing.stats.map(normalizeStat), ...names.filter((name) => !seen.has(name)).map((name) => normalizeStat({ name, selected: 0 }))]
  };
}

export async function recordAvenueOutcome(paths: RunPaths, config: WiCiConfig, avenueName: string, entry: LedgerEntry): Promise<AvenueState> {
  const state = await loadAvenueState(paths, config);
  const success = entry.status === 'keep' && (entry.delta_pct ?? 0) > 0;
  const failure = entry.status !== 'keep';
  const next: AvenueState = {
    version: state.version + 1,
    stats: state.stats.map((item) => {
      if (item.name !== avenueName) return item;
      if (item.last_outcome_ledger_id === entry.id) return item;
      return {
        ...item,
        successes: (item.successes ?? 0) + (success ? 1 : 0),
        failures: (item.failures ?? 0) + (failure ? 1 : 0),
        downstream_delta_pct: Number(((item.downstream_delta_pct ?? 0) + (success ? (entry.delta_pct ?? 0) : 0)).toFixed(6)),
        last_outcome_ledger_id: entry.id
      };
    })
  };
  await atomicWriteJson(paths.avenues, next);
  return next;
}

function normalizeStat(stat: AvenueStat): AvenueStat {
  return {
    ...stat,
    selected: stat.selected ?? 0,
    successes: stat.successes ?? 0,
    failures: stat.failures ?? 0,
    downstream_delta_pct: stat.downstream_delta_pct ?? 0
  };
}

function thompsonRng(): () => number {
  const seedRaw = process.env.WICI_THOMPSON_SEED;
  if (!seedRaw) return Math.random;
  const seed = Number(seedRaw);
  return mulberry32(Number.isFinite(seed) ? seed : hashSeed(seedRaw));
}

function betaSample(alpha: number, beta: number, rng: () => number): number {
  const a = gammaIntegerSample(Math.max(1, Math.trunc(alpha)), rng);
  const b = gammaIntegerSample(Math.max(1, Math.trunc(beta)), rng);
  return a / (a + b);
}

function gammaIntegerSample(shape: number, rng: () => number): number {
  let sum = 0;
  for (let i = 0; i < shape; i++) {
    sum += -Math.log(Math.max(Number.MIN_VALUE, 1 - rng()));
  }
  return sum;
}

function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
