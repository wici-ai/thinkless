import { readFile, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile, atomicWriteJson, ensureDir, exists, readJsonFile, removeIfExists } from '../shared/atomic.js';
import type { GoalFile, Injection, InjectionKind } from '../shared/types.js';
import type { RunPaths } from '../shared/paths.js';

const allowedKinds: InjectionKind[] = ['add_requirement', 'drop_requirement', 'steer', 'answer', 'abort'];

export async function writeInjection(paths: RunPaths, input: { kind: InjectionKind; text: string; priority?: Injection['priority']; reply_to?: string }): Promise<Injection> {
  await ensureDir(paths.inbox);
  const injection: Injection = {
    id: `inj-${Date.now()}-${randomUUID().slice(0, 8)}`,
    ts: new Date().toISOString(),
    kind: input.kind,
    text: input.text,
    priority: input.priority ?? 'normal',
    reply_to: input.reply_to,
    applied: false
  };
  await atomicWriteJson(join(paths.inbox, `${injection.id}.json`), injection);
  if (injection.priority === 'urgent') {
    await recordUrgentSentinel(paths, injection.id);
  }
  return injection;
}

export async function drainInbox(paths: RunPaths, drainedIds: string[], cap = 8, kinds?: InjectionKind[], replyTo?: string): Promise<Injection[]> {
  await ensureDir(paths.inboxDone);
  if (!(await exists(paths.inbox))) return [];

  const files = (await readdir(paths.inbox))
    .filter((name) => /^inj-.+\.json$/.test(name))
    .map((name) => join(paths.inbox, name));

  const urgentIds = await readUrgentSentinelIds(paths);
  const withStats = await Promise.all(
    files.map(async (path) => {
      const injection = validateInjection(await readJsonFile<Injection>(path));
      return {
        path,
        injection,
        urgent: injection.priority === 'urgent' && urgentIds.has(injection.id),
        mtimeMs: (await stat(path)).mtimeMs
      };
    })
  );

  const drained: Injection[] = [];
  for (const item of withStats.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.mtimeMs - b.mtimeMs)) {
    if (drained.length >= cap) break;
    const injection = item.injection;
    if (injection.kind === 'abort' && !urgentIds.has(injection.id)) continue;
    if (kinds && !kinds.includes(injection.kind)) continue;
    if (replyTo && injection.reply_to !== replyTo) continue;
    if (drainedIds.includes(injection.id)) {
      await rename(item.path, join(paths.inboxDone, `${injection.id}.duplicate.json`)).catch(() => undefined);
      continue;
    }
    const donePath = join(paths.inboxDone, `${injection.id}.json`);
    await rename(item.path, donePath);
    drained.push({ ...injection, applied: true });
  }

  await syncUrgentSentinel(paths, urgentIds, new Set(injectionIds(drained)));

  return coalesceInjections(drained);
}

export async function readPendingInjections(paths: RunPaths, drainedIds: string[], kinds?: InjectionKind[]): Promise<Injection[]> {
  if (!(await exists(paths.inbox))) return [];

  const files = (await readdir(paths.inbox))
    .filter((name) => /^inj-.+\.json$/.test(name))
    .map((name) => join(paths.inbox, name));
  const urgentIds = await readUrgentSentinelIds(paths);
  const withStats = await Promise.all(
    files.map(async (path) => {
      const injection = validateInjection(await readJsonFile<Injection>(path));
      return {
        injection,
        urgent: injection.priority === 'urgent' && urgentIds.has(injection.id),
        mtimeMs: (await stat(path)).mtimeMs
      };
    })
  );

  return withStats
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.mtimeMs - b.mtimeMs)
    .map((item) => item.injection)
    .filter((injection) => !drainedIds.includes(injection.id))
    .filter((injection) => !kinds || kinds.includes(injection.kind));
}

export async function drainPendingInjectionsById(paths: RunPaths, drainedIds: string[], ids: string[]): Promise<Injection[]> {
  await ensureDir(paths.inboxDone);
  if (!(await exists(paths.inbox))) return [];
  const wanted = new Set(ids);
  const files = (await readdir(paths.inbox))
    .filter((name) => /^inj-.+\.json$/.test(name))
    .map((name) => join(paths.inbox, name));
  const urgentIds = await readUrgentSentinelIds(paths);
  const drained: Injection[] = [];

  for (const path of files) {
    const injection = validateInjection(await readJsonFile<Injection>(path));
    if (!wanted.has(injection.id)) continue;
    if (drainedIds.includes(injection.id)) {
      await rename(path, join(paths.inboxDone, `${injection.id}.duplicate.json`)).catch(() => undefined);
      continue;
    }
    await rename(path, join(paths.inboxDone, `${injection.id}.json`));
    drained.push({ ...injection, applied: true });
  }

  await syncUrgentSentinel(paths, urgentIds, new Set(injectionIds(drained)));
  return drained;
}

export function injectionIds(injections: Injection[]): string[] {
  return [...new Set(injections.flatMap((item) => item.coalesced_ids ?? [item.id]))];
}

export function applyInjections(goal: GoalFile, injections: Injection[]): { goal: GoalFile; steerText: string | undefined; aborted: boolean } {
  if (injections.length === 0) return { goal, steerText: undefined, aborted: false };

  let next: GoalFile = {
    ...goal,
    version: goal.version + 1,
    requirements: [...goal.requirements],
    acceptance_criteria: [...goal.acceptance_criteria],
    constraints: [...goal.constraints]
  };
  const steer: string[] = [];
  let aborted = false;

  for (const injection of injections) {
    if (injection.kind === 'add_requirement') {
      next.requirements.push({
        id: `R${next.requirements.length + 1}`,
        text: injection.text,
        source: 'chat',
        status: 'active'
      });
      steer.push(injection.text);
    } else if (injection.kind === 'drop_requirement') {
      next.requirements = next.requirements.map((req) =>
        req.text.includes(injection.text) || req.id === injection.text ? { ...req, status: 'dropped' } : req
      );
      steer.push(`Drop requirement: ${injection.text}`);
    } else if (injection.kind === 'steer') {
      next.constraints.push(`Steering: ${injection.text}`);
      steer.push(injection.text);
    } else if (injection.kind === 'answer') {
      const label = injection.reply_to ? `Answer to ${injection.reply_to}` : 'Answer';
      next.constraints.push(`${label}: ${injection.text}`);
      steer.push(`${label}: ${injection.text}`);
    } else if (injection.kind === 'abort' && injection.priority === 'urgent') {
      aborted = true;
      steer.push(`Urgent abort requested: ${injection.text}`);
    }
  }

  return {
    goal: next,
    steerText: steer.length > 0 ? steer.join('\n') : undefined,
    aborted
  };
}

function validateInjection(injection: Injection): Injection {
  if (!allowedKinds.includes(injection.kind)) {
    throw new Error(`Invalid injection kind: ${String(injection.kind)}`);
  }
  if (injection.kind === 'abort' && injection.priority !== 'urgent') {
    throw new Error('abort injection requires priority=urgent');
  }
  if (injection.kind === 'answer' && !injection.reply_to) {
    throw new Error('answer injection requires reply_to');
  }
  if (!injection.id || !injection.ts || typeof injection.text !== 'string') {
    throw new Error(`Invalid injection shape: ${JSON.stringify(injection)}`);
  }
  return injection;
}

async function recordUrgentSentinel(paths: RunPaths, id: string): Promise<void> {
  const ids = await readUrgentSentinelIds(paths);
  ids.add(id);
  await writeUrgentSentinelIds(paths, ids);
}

async function readUrgentSentinelIds(paths: RunPaths): Promise<Set<string>> {
  if (!(await exists(paths.urgentSentinel))) return new Set();
  const raw = await readFile(paths.urgentSentinel, 'utf8');
  return new Set(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

async function writeUrgentSentinelIds(paths: RunPaths, ids: Set<string>): Promise<void> {
  if (ids.size === 0) {
    await removeIfExists(paths.urgentSentinel);
    return;
  }
  await atomicWriteFile(paths.urgentSentinel, `${[...ids].sort().join('\n')}\n`);
}

async function syncUrgentSentinel(paths: RunPaths, urgentIds: Set<string>, drainedIds: Set<string>): Promise<void> {
  if (urgentIds.size === 0) return;
  const pending = await pendingInjectionIds(paths);
  const remaining = new Set([...urgentIds].filter((id) => !drainedIds.has(id) && pending.has(id)));
  await writeUrgentSentinelIds(paths, remaining);
}

async function pendingInjectionIds(paths: RunPaths): Promise<Set<string>> {
  if (!(await exists(paths.inbox))) return new Set();
  const names = (await readdir(paths.inbox)).filter((name) => /^inj-.+\.json$/.test(name));
  const ids = new Set<string>();
  for (const name of names) {
    const injection = validateInjection(await readJsonFile<Injection>(join(paths.inbox, name)));
    ids.add(injection.id);
  }
  return ids;
}

function coalesceInjections(injections: Injection[]): Injection[] {
  const result: Injection[] = [];
  for (const injection of injections) {
    if (!isCoalescable(injection.kind)) {
      result.push(injection);
      continue;
    }

    const previous = result.at(-1);
    if (!previous || previous.kind !== injection.kind) {
      result.push({ ...injection, coalesced_ids: injectionIds([injection]) });
      continue;
    }

    result[result.length - 1] = {
      ...previous,
      id: injection.id,
      ts: injection.ts,
      text: `${previous.text}\n${injection.text}`,
      priority: previous.priority === 'urgent' || injection.priority === 'urgent' ? 'urgent' : previous.priority,
      coalesced_ids: injectionIds([previous, injection])
    };
  }
  return result;
}

function isCoalescable(kind: InjectionKind): boolean {
  return kind === 'add_requirement' || kind === 'steer';
}
