import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteJson, exists } from '../shared/atomic.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { GoalFile, Injection } from '../shared/types.js';
import { applyInjections, drainInbox, injectionIds, writeInjection } from '../supervisor/inbox.js';

async function main(): Promise<void> {
  await assertCoalescingKeepsAllIds();
  await assertUrgentBypassesCapAndUsesSentinel();
  await assertAbortRequiresUrgentSentinel();

  console.log(
    JSON.stringify(
      {
        ok: true,
        coalesced_add_requirement: true,
        coalesced_steer: true,
        drained_ids_preserved: true,
        urgent_sentinel_required: true
      },
      null,
      2
    )
  );
}

async function assertCoalescingKeepsAllIds(): Promise<void> {
  await withInbox(async (paths) => {
    const addA = await writeInjection(paths, { kind: 'add_requirement', text: 'Keep API stable', priority: 'normal' });
    const addB = await writeInjection(paths, { kind: 'add_requirement', text: 'Keep memory bounded', priority: 'normal' });
    const steerA = await writeInjection(paths, { kind: 'steer', text: 'Inspect the hot loop first', priority: 'normal' });
    const steerB = await writeInjection(paths, { kind: 'steer', text: 'Prefer linear data structures', priority: 'normal' });

    const drained = await drainInbox(paths, []);
    const ids = injectionIds(drained);
    assert(ids.length === 4, `expected four original drained ids, got ${ids.join(',')}`);
    for (const injection of [addA, addB, steerA, steerB]) {
      assert(ids.includes(injection.id), `missing drained id ${injection.id}`);
    }

    const add = byKind(drained, 'add_requirement');
    const steer = byKind(drained, 'steer');
    assert(drained.length === 2, `expected add_requirement and steer to coalesce to two injections, got ${drained.length}`);
    assert(add.text === 'Keep API stable\nKeep memory bounded', `unexpected coalesced add text: ${add.text}`);
    assert(steer.text === 'Inspect the hot loop first\nPrefer linear data structures', `unexpected coalesced steer text: ${steer.text}`);

    const applied = applyInjections(makeGoal(), drained);
    assert(applied.goal.version === 2, `expected one goal version bump, got ${applied.goal.version}`);
    assert(applied.goal.requirements.some((req) => req.text.includes('Keep API stable') && req.text.includes('Keep memory bounded')), 'coalesced requirement missing from goal');
    assert(applied.steerText?.includes('Inspect the hot loop first'), 'coalesced steer text missing first steer');
    assert(applied.steerText?.includes('Prefer linear data structures'), 'coalesced steer text missing second steer');
  });
}

async function assertUrgentBypassesCapAndUsesSentinel(): Promise<void> {
  await withInbox(async (paths) => {
    const normalA = await writeInjection(paths, { kind: 'steer', text: 'normal first', priority: 'normal' });
    const normalB = await writeInjection(paths, { kind: 'steer', text: 'normal second', priority: 'normal' });
    const urgent = await writeInjection(paths, { kind: 'steer', text: 'urgent steer', priority: 'urgent' });
    assert(await exists(paths.urgentSentinel), 'urgent injection did not create inbox/URGENT sentinel');

    const drained = await drainInbox(paths, [], 2);
    const ids = injectionIds(drained);
    assert(ids.includes(urgent.id), `urgent injection was blocked by cap: ${ids.join(',')}`);
    assert(ids.includes(normalA.id), 'oldest normal injection should fill remaining cap slot');
    assert(!ids.includes(normalB.id), 'cap should leave the second normal injection pending');
    assert(await exists(paths.urgentSentinel) === false, 'URGENT sentinel should be removed after all urgent injections drain');

    const pending = await inboxJsonFiles(paths.inbox);
    assert(pending.length === 1 && pending[0].includes(normalB.id), `expected one pending normal injection, got ${pending.join(',')}`);
  });
}

async function assertAbortRequiresUrgentSentinel(): Promise<void> {
  await withInbox(async (paths) => {
    const manualAbort: Injection = {
      id: 'inj-manual-abort',
      ts: new Date().toISOString(),
      kind: 'abort',
      text: 'stop without sentinel',
      priority: 'urgent',
      applied: false
    };
    await atomicWriteJson(join(paths.inbox, `${manualAbort.id}.json`), manualAbort);
    const skipped = await drainInbox(paths, []);
    assert(skipped.length === 0, 'abort without URGENT sentinel should not be drained');
    assert(await exists(join(paths.inbox, `${manualAbort.id}.json`)), 'abort without sentinel should remain pending, not be applied');

    const abort = await writeInjection(paths, { kind: 'abort', text: 'stop now', priority: 'urgent' });
    const drained = await drainInbox(paths, []);
    const ids = injectionIds(drained);
    assert(ids.includes(abort.id), 'urgent abort created through writeInjection was not drained');
    assert(!ids.includes(manualAbort.id), 'manual abort should not be applied by a different urgent sentinel');
    assert(await exists(join(paths.inbox, `${manualAbort.id}.json`)), 'manual abort should remain pending after unrelated urgent abort drains');
    assert(await exists(paths.urgentSentinel) === false, 'URGENT sentinel should clear after urgent abort drains');
    const applied = applyInjections(makeGoal(), drained);
    assert(applied.aborted === true, 'urgent abort did not set aborted=true');
  });
}

async function withInbox(fn: (paths: ReturnType<typeof runPaths>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'wici-inbox-'));
  try {
    const paths = runPaths(dir);
    await ensureRunDirs(paths);
    await fn(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function inboxJsonFiles(inbox: string): Promise<string[]> {
  return (await readdir(inbox)).filter((name) => /^inj-.+\.json$/.test(name)).sort();
}

function byKind(injections: Injection[], kind: Injection['kind']): Injection {
  const found = injections.find((item) => item.kind === kind);
  assert(found, `missing ${kind} injection in ${JSON.stringify(injections)}`);
  return found;
}

function makeGoal(): GoalFile {
  return {
    run_id: 'run-inbox-backpressure',
    version: 1,
    requirements: [{ id: 'R1', text: 'Optimize p99 latency', source: 'initial', status: 'active' }],
    acceptance_criteria: [{ id: 'A1', text: 'Checks pass', check: './.opt/checks.sh' }],
    constraints: [],
    metric: { name: 'p99 latency', direction: 'minimize', target: null, unit: 'ms' },
    budget: { max_iters: 4, max_cost_usd: 0, deadline: null },
    stop: { tau: 0, K: 2, N: 2, mode: 'auto' }
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
