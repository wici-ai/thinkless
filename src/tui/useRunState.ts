import { useEffect, useMemo, useRef, useState } from 'react';
import chokidar from 'chokidar';
import { open, readFile, readdir } from 'node:fs/promises';
import { runPaths } from '../shared/paths.js';
import type { BaselineFile, ChatLogEntry, Checkpoint, GoalFile, Injection, LedgerEntry, OutboxMessage, RunEvent } from '../shared/types.js';
import { exists } from '../shared/atomic.js';

const UI_REFRESH_DEBOUNCE_MS = 250;
const JSONL_TAIL_BYTES = 384 * 1024;
const CODEX_RUN_TAIL_BYTES = 256 * 1024;
const CODEX_RUN_MAX_LINE_CHARS = 2_000;
const CODEX_RUN_LINES = 240;

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

export function useRunState(target: string, sessionDir?: string): RunState {
  const paths = useMemo(() => runPaths(target, sessionDir), [target, sessionDir]);
  const [state, setState] = useState<RunState>(() => emptyRunState(paths.target));
  // Keep the last committed signature so we only re-render when blackboard
  // content actually changed; an unconditional setState on every poll/watch
  // tick re-renders the whole TUI and is the primary flicker source.
  const lastSignatureRef = useRef<string>(stateSignature(emptyRunState(paths.target)));

  useEffect(() => {
    let alive = true;
    let timer: NodeJS.Timeout | null = null;
    let poller: NodeJS.Timeout | null = null;
    lastSignatureRef.current = stateSignature(emptyRunState(paths.target));
    setState(emptyRunState(paths.target));

    const load = async () => {
      const next = await readState(paths.target, sessionDir).catch(() => null);
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
      }, UI_REFRESH_DEBOUNCE_MS);
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
  }, [paths.target, paths.stateDir, paths.events, paths.codexRun, paths.goal, paths.goalDoc, paths.checkpoint, paths.baseline, paths.ledger, paths.plan, paths.outbox, paths.inbox, paths.inboxDone, paths.chat]);

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

async function readState(target: string, sessionDir?: string): Promise<RunState> {
  const paths = runPaths(target, sessionDir);
  const [goal, checkpoint, baseline, ledger, goalDoc, plan, events, codexTranscript, outbox, injections, chat] = await Promise.all([
    readJsonMaybe<GoalFile>(paths.goal),
    readJsonMaybe<Checkpoint>(paths.checkpoint),
    readJsonMaybe<BaselineFile>(paths.baseline),
    readJsonLinesTailMaybe<LedgerEntry>(paths.ledger, 200),
    readTextMaybe(paths.goalDoc),
    readTextMaybe(paths.plan),
    readJsonLinesTailMaybe<RunEvent>(paths.events, 500),
    readRawLinesMaybe(paths.codexRun, CODEX_RUN_LINES),
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
  return readTailLinesMaybe(path, limit, {
    maxBytes: CODEX_RUN_TAIL_BYTES,
    maxLineChars: CODEX_RUN_MAX_LINE_CHARS,
    dropPartialFirstLine: false,
    truncationLabel: 'see .wici/codex-run.jsonl for the full raw line'
  });
}

async function readChatLog(path: string): Promise<ChatLogEntry[]> {
  const entries = await readJsonLinesTailMaybe<ChatLogEntry>(path, 80);
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
  return parseJsonLines<T>(raw.split('\n'));
}

async function readJsonLinesTailMaybe<T>(path: string, limit: number): Promise<T[]> {
  const lines = await readTailLinesMaybe(path, limit, {
    maxBytes: JSONL_TAIL_BYTES,
    dropPartialFirstLine: true
  });
  return parseJsonLines<T>(lines);
}

function parseJsonLines<T>(lines: string[]): T[] {
  const parsed: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed) as T);
    } catch {
      // Tail reads can start in the middle of a JSONL record; ignore that fragment.
    }
  }
  return parsed;
}

async function readTailLinesMaybe(
  path: string,
  limit: number,
  options: {
    maxBytes?: number;
    maxLineChars?: number;
    dropPartialFirstLine?: boolean;
    truncationLabel?: string;
  } = {}
): Promise<string[]> {
  if (!(await exists(path))) return [];
  const maxBytes = options.maxBytes ?? JSONL_TAIL_BYTES;
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const position = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    const raw = buffer.toString('utf8');
    let lines = raw.split('\n');
    if (position > 0 && raw.length > 0 && !raw.startsWith('\n') && !raw.startsWith('\r')) {
      if (options.dropPartialFirstLine ?? true) {
        lines = lines.slice(1);
      } else {
        lines[0] = `[tail clipped] ${lines[0]}`;
      }
    }
    return lines
      .filter((line) => line.trim())
      .slice(-limit)
      .map((line) => clipLine(line, options.maxLineChars, options.truncationLabel));
  } finally {
    await handle.close();
  }
}

function clipLine(line: string, maxChars?: number, label = 'full line on disk'): string {
  if (!maxChars || line.length <= maxChars) return line;
  const suffix = ` ... [truncated ${line.length - maxChars} chars; ${label}]`;
  return `${line.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
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
  const [pending, done] = await Promise.all([readInjectionDir(inbox), readInjectionDir(inboxDone, true)]);
  return [...pending, ...done]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-16);
}

async function readInjectionDir(path: string, forceApplied = false): Promise<Injection[]> {
  if (!(await exists(path))) return [];
  const names = (await readdir(path)).filter((name) => /^inj-.+\.json$/.test(name)).sort().slice(-24);
  const items = await Promise.all(
    names.map(async (name): Promise<Injection | null> => {
      const message = await readJsonMaybe<Injection>(`${path}/${name}`);
      if (!message || typeof message.text !== 'string' || typeof message.kind !== 'string') return null;
      return forceApplied ? { ...message, applied: true } : message;
    })
  );
  return items.filter((item): item is Injection => Boolean(item));
}
