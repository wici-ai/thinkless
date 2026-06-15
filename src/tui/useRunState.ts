import { useEffect, useMemo, useRef, useState } from 'react';
import chokidar from 'chokidar';
import { readFile, readdir } from 'node:fs/promises';
import { runPaths } from '../shared/paths.js';
import type { BaselineFile, ChatLogEntry, Checkpoint, GoalFile, Injection, LedgerEntry, OutboxMessage, RunEvent } from '../shared/types.js';
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
  codexTranscript: string[];
  outbox: OutboxMessage[];
  injections: Injection[];
  chat: ChatLogEntry[];
}

function emptyRunState(target: string): RunState {
  return {
    target,
    goal: null,
    checkpoint: null,
    baseline: null,
    ledger: [],
    goalDoc: '',
    plan: '',
    events: [],
    codexTranscript: [],
    outbox: [],
    injections: [],
    chat: []
  };
}

export function useRunState(target: string): RunState {
  const paths = useMemo(() => runPaths(target), [target]);
  const [state, setState] = useState<RunState>(() => emptyRunState(paths.target));
  // Keep the last committed signature so we only re-render when blackboard
  // content actually changed; an unconditional setState on every poll/watch
  // tick re-renders the whole TUI and is the primary flicker source.
  const lastSignatureRef = useRef<string>(stateSignature(emptyRunState(paths.target)));

  useEffect(() => {
    let alive = true;
    let timer: NodeJS.Timeout | null = null;
    let poller: NodeJS.Timeout | null = null;

    const load = async () => {
      const next = await readState(paths.target).catch(() => null);
      if (!alive || !next) return;
      const signature = stateSignature(next);
      if (signature === lastSignatureRef.current) return;
      lastSignatureRef.current = signature;
      setState(next);
    };

    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 30);
    };

    void load();
    // Slow safety poll only: chokidar drives normal refreshes, and load() is a
    // no-op when nothing changed, so this is just a watcher-miss backstop.
    poller = setInterval(() => {
      void load();
    }, 1500);
    const watcher = chokidar.watch([paths.events, paths.codexRun, paths.goal, paths.goalDoc, paths.checkpoint, paths.baseline, paths.ledger, paths.plan, paths.outbox, paths.inbox, paths.inboxDone, paths.chat], {
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
  }, [paths.target, paths.events, paths.codexRun, paths.goal, paths.goalDoc, paths.checkpoint, paths.baseline, paths.ledger, paths.plan, paths.outbox, paths.inbox, paths.inboxDone, paths.chat]);

  return state;
}

// Cheap content fingerprint: changes when any rendered blackboard slice changes.
// Includes in-place mutations (outbox.answered, injection.applied) so answered
// questions and applied injections still refresh the Chat pane.
export function stateSignature(state: RunState): string {
  const lastEvent = state.events.at(-1);
  const lastCodex = state.codexTranscript.at(-1);
  const lastLedger = state.ledger.at(-1);
  const lastOutbox = state.outbox.at(-1);
  const lastInjection = state.injections.at(-1);
  const lastChat = state.chat.at(-1);
  const answered = state.outbox.reduce((count, message) => count + (message.answered ? 1 : 0), 0);
  const applied = state.injections.reduce((count, injection) => count + (injection.applied ? 1 : 0), 0);
  return [
    state.goal ? `${state.goal.run_id}:${state.goal.version}` : '-',
    state.checkpoint ? `${state.checkpoint.supervisor_state}:${state.checkpoint.iter}:${state.checkpoint.events_seq}:${state.checkpoint.ledger_seq}:${state.checkpoint.best_commit ?? ''}:${state.checkpoint.updated_at}` : '-',
    state.baseline ? state.baseline.updated_at : '-',
    `g${state.goalDoc.length}`,
    `p${state.plan.length}`,
    `e${state.events.length}:${lastEvent?.seq ?? lastEvent?.ts ?? ''}`,
    `x${state.codexTranscript.length}:${lastCodex?.length ?? 0}:${lastCodex?.slice(0, 20) ?? ''}`,
    `l${state.ledger.length}:${lastLedger?.id ?? ''}`,
    `o${state.outbox.length}:${answered}:${lastOutbox?.id ?? ''}`,
    `i${state.injections.length}:${applied}:${lastInjection?.id ?? ''}`,
    `c${state.chat.length}:${lastChat?.ts ?? ''}`
  ].join('|');
}

async function readState(target: string): Promise<RunState> {
  const paths = runPaths(target);
  const [goal, checkpoint, baseline, ledger, goalDoc, plan, events, codexTranscript, outbox, injections, chat] = await Promise.all([
    readJsonMaybe<GoalFile>(paths.goal),
    readJsonMaybe<Checkpoint>(paths.checkpoint),
    readJsonMaybe<BaselineFile>(paths.baseline),
    readJsonLinesMaybe<LedgerEntry>(paths.ledger),
    readTextMaybe(paths.goalDoc),
    readTextMaybe(paths.plan),
    readJsonLinesMaybe<RunEvent>(paths.events),
    readRawLinesMaybe(paths.codexRun, 600),
    readOutboxMessages(paths.outbox),
    readInjectionHistory(paths.inbox, paths.inboxDone),
    readChatLog(paths.chat)
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
    codexTranscript,
    outbox,
    injections,
    chat
  };
}

async function readRawLinesMaybe(path: string, limit: number): Promise<string[]> {
  const raw = await readTextMaybe(path);
  return raw.split('\n').filter((line) => line.trim()).slice(-limit);
}

async function readChatLog(path: string): Promise<ChatLogEntry[]> {
  const entries = await readJsonLinesMaybe<ChatLogEntry>(path);
  return entries.filter((entry) => entry && typeof entry.text === 'string' && (entry.role === 'user' || entry.role === 'assistant')).slice(-40);
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
