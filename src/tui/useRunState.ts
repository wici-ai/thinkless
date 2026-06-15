import { useEffect, useMemo, useState } from 'react';
import chokidar from 'chokidar';
import { readFile, readdir } from 'node:fs/promises';
import { runPaths } from '../shared/paths.js';
import type { BaselineFile, Checkpoint, GoalFile, Injection, LedgerEntry, OutboxMessage, RunEvent } from '../shared/types.js';
import { exists } from '../shared/atomic.js';

export interface RunState {
  target: string;
  goal: GoalFile | null;
  checkpoint: Checkpoint | null;
  baseline: BaselineFile | null;
  ledger: LedgerEntry[];
  goalDoc: string;
  plan: string;
  events: RunEvent[];
  outbox: OutboxMessage[];
  injections: Injection[];
}

export function useRunState(target: string): RunState {
  const paths = useMemo(() => runPaths(target), [target]);
  const [state, setState] = useState<RunState>({
    target: paths.target,
    goal: null,
    checkpoint: null,
    baseline: null,
    ledger: [],
    goalDoc: '',
    plan: '',
    events: [],
    outbox: [],
    injections: []
  });

  useEffect(() => {
    let alive = true;
    let timer: NodeJS.Timeout | null = null;
    let poller: NodeJS.Timeout | null = null;

    const load = async () => {
      const next = await readState(paths.target);
      if (alive) setState(next);
    };

    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 30);
    };

    void load();
    poller = setInterval(() => {
      void load();
    }, 300);
    const watcher = chokidar.watch([paths.events, paths.goal, paths.goalDoc, paths.checkpoint, paths.baseline, paths.ledger, paths.plan, paths.outbox, paths.inbox, paths.inboxDone], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 20 }
    });
    watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      void watcher.close();
    };
  }, [paths.target, paths.events, paths.goal, paths.goalDoc, paths.checkpoint, paths.baseline, paths.ledger, paths.plan, paths.outbox, paths.inbox, paths.inboxDone]);

  return state;
}

async function readState(target: string): Promise<RunState> {
  const paths = runPaths(target);
  const [goal, checkpoint, baseline, ledger, goalDoc, plan, events, outbox, injections] = await Promise.all([
    readJsonMaybe<GoalFile>(paths.goal),
    readJsonMaybe<Checkpoint>(paths.checkpoint),
    readJsonMaybe<BaselineFile>(paths.baseline),
    readJsonLinesMaybe<LedgerEntry>(paths.ledger),
    readTextMaybe(paths.goalDoc),
    readTextMaybe(paths.plan),
    readJsonLinesMaybe<RunEvent>(paths.events),
    readOutboxMessages(paths.outbox),
    readInjectionHistory(paths.inbox, paths.inboxDone)
  ]);
  return {
    target: paths.target,
    goal,
    checkpoint,
    baseline,
    ledger,
    goalDoc,
    plan,
    events,
    outbox,
    injections
  };
}

async function readTextMaybe(path: string): Promise<string> {
  if (!(await exists(path))) return '';
  return readFile(path, 'utf8');
}

async function readJsonMaybe<T>(path: string): Promise<T | null> {
  const raw = await readTextMaybe(path);
  if (!raw.trim()) return null;
  return JSON.parse(raw) as T;
}

async function readJsonLinesMaybe<T>(path: string): Promise<T[]> {
  const raw = await readTextMaybe(path);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readOutboxMessages(path: string): Promise<OutboxMessage[]> {
  if (!(await exists(path))) return [];
  const names = (await readdir(path)).filter((name) => /^out-.+\.json$/.test(name)).sort().slice(-12);
  return Promise.all(names.map((name) => readJsonMaybe<OutboxMessage>(`${path}/${name}`).then((message) => message).then((message) => {
    if (!message) throw new Error(`Invalid outbox message: ${name}`);
    return message;
  })));
}

async function readInjectionHistory(inbox: string, inboxDone: string): Promise<Injection[]> {
  const [pending, done] = await Promise.all([readInjectionDir(inbox), readInjectionDir(inboxDone)]);
  return [...pending, ...done]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-16);
}

async function readInjectionDir(path: string): Promise<Injection[]> {
  if (!(await exists(path))) return [];
  const names = (await readdir(path)).filter((name) => /^inj-.+\.json$/.test(name)).sort().slice(-24);
  const items = await Promise.all(
    names.map(async (name) => {
      const message = await readJsonMaybe<Injection>(`${path}/${name}`);
      return message && typeof message.text === 'string' && typeof message.kind === 'string' ? message : null;
    })
  );
  return items.filter((item): item is Injection => Boolean(item));
}
