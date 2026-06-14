import { readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, ensureDir, exists, readJsonFile } from '../shared/atomic.js';
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
  return injection;
}

export async function drainInbox(paths: RunPaths, drainedIds: string[], cap = 8, kinds?: InjectionKind[], replyTo?: string): Promise<Injection[]> {
  await ensureDir(paths.inboxDone);
  if (!(await exists(paths.inbox))) return [];

  const files = (await readdir(paths.inbox))
    .filter((name) => /^inj-.+\.json$/.test(name))
    .map((name) => join(paths.inbox, name));

  const withStats = await Promise.all(
    files.map(async (path) => ({
      path,
      mtimeMs: (await stat(path)).mtimeMs
    }))
  );

  const drained: Injection[] = [];
  for (const item of withStats.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (drained.length >= cap) break;
    const injection = validateInjection(await readJsonFile<Injection>(item.path));
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

  return coalesceInjections(drained);
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

function coalesceInjections(injections: Injection[]): Injection[] {
  const steer = injections.filter((item) => item.kind === 'steer');
  const rest = injections.filter((item) => item.kind !== 'steer');
  if (steer.length <= 1) return injections;
  return [
    ...rest,
    {
      ...steer[steer.length - 1],
      text: steer.map((item) => item.text).join('\n')
    }
  ];
}
