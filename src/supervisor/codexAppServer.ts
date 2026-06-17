import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { schemaPath, type RunPaths } from '../shared/paths.js';
import type { Checkpoint, ToolUsageSummary, WiCiConfig } from '../shared/types.js';
import { CodexRunError, parseCodexRunEvents } from './codexRun.js';

// Bound in-memory accumulation so a single long turn cannot grow a string past
// V8's ~512MB max length (RangeError: Invalid string length) or exhaust the
// heap. The full stream is already durable on disk in codex-run.jsonl.
const STDOUT_TAIL_CHARS = 1_000_000;
const STDERR_TAIL_CHARS = 65_536;
const MAX_USAGE_ERRORS = 50;

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export interface CodexAppTurn {
  threadId: string;
  turnId: string;
  done: Promise<{ usage: ToolUsageSummary; stdout: string }>;
  steer: (text: string) => Promise<boolean>;
  interrupt: () => Promise<void>;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export async function startCodexAppServerTurn(input: {
  paths: RunPaths;
  config: WiCiConfig;
  checkpoint: Checkpoint;
  prompt: string;
  artifactId: string;
  onRawNotification?: (line: string, usage: ToolUsageSummary, method?: string) => Promise<void>;
}): Promise<CodexAppTurn> {
  const client = new CodexAppServerClient(input.config.tools.executor.command, input.paths, input.config.tools.executor.effort);
  await client.start();
  let usage = emptyUsageSummary();
  let stdout = '';
  let activeTurnId = '';
  let completed = false;
  let completionResolve: (() => void) | undefined;
  let completionReject: ((error: Error) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });

  client.onNotification = async (message, raw) => {
    stdout = tail(stdout + `${raw}\n`, STDOUT_TAIL_CHARS);
    await appendFile(input.paths.codexRun, `${raw}\n`);
    const delta = parseCodexRunEvents(raw);
    usage = mergeUsageSummary(usage, delta);
    await input.onRawNotification?.(raw, cloneUsageSummary(usage), message.method);
    if (message.method === 'turn/started') {
      const turn = recordValue(recordValue(message.params)?.turn);
      const id = stringValue(turn?.id);
      if (id) activeTurnId = id;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const tokenUsage = recordValue(recordValue(message.params)?.tokenUsage);
      const total = recordValue(tokenUsage?.total);
      if (typeof total?.inputTokens === 'number') usage.tokens_input = total.inputTokens;
      if (typeof total?.outputTokens === 'number') usage.tokens_output = total.outputTokens;
    }
    if (message.method === 'turn/completed') {
      const turn = recordValue(recordValue(message.params)?.turn);
      if (!activeTurnId) activeTurnId = stringValue(turn?.id) ?? '';
      completed = true;
      completionResolve?.();
    }
    if (message.method === 'error') {
      const params = recordValue(message.params);
      const error = recordValue(params?.error);
      usage.failed = true;
      usage.errors.push(stringValue(error?.message) ?? stringValue(params?.message) ?? raw);
      if (usage.errors.length > MAX_USAGE_ERRORS) usage.errors = usage.errors.slice(-MAX_USAGE_ERRORS);
      completionReject?.(new CodexRunError(`Codex app-server error: ${usage.errors.at(-1)}`, cloneUsageSummary(usage)));
    }
  };

  let threadId: string;
  try {
    await client.initialize();
    threadId = await ensureThread(client, input);
    const turnResponse = recordValue(
      await client.request('turn/start', {
        threadId,
        clientUserMessageId: `wici-${input.artifactId}`,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        cwd: input.paths.target,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        model: input.config.tools.executor.model ?? null,
        outputSchema: await readOutputSchema()
      })
    );
    const turn = recordValue(turnResponse?.turn);
    activeTurnId = stringValue(turn?.id) ?? activeTurnId;
    if (!activeTurnId) throw new Error('codex app-server turn/start did not return a turn id');
  } catch (error) {
    await client.close();
    throw error;
  }

  return {
    threadId,
    turnId: activeTurnId,
    done: completion
      .then(async () => {
        await client.close();
        return { usage: cloneUsageSummary(usage), stdout };
      })
      .catch(async (error) => {
        await client.close();
        throw error;
      }),
    steer: async (text: string) => {
      if (completed || !activeTurnId) return false;
      try {
        await client.request('turn/steer', {
          threadId,
          expectedTurnId: activeTurnId,
          clientUserMessageId: `wici-steer-${Date.now()}`,
          input: [{ type: 'text', text, text_elements: [] }]
        });
        return true;
      } catch {
        return false;
      }
    },
    interrupt: async () => {
      if (completed || !activeTurnId) return;
      await client.request('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => undefined);
    }
  };
}

async function ensureThread(client: CodexAppServerClient, input: {
  paths: RunPaths;
  config: WiCiConfig;
  checkpoint: Checkpoint;
}): Promise<string> {
  const existing = input.checkpoint.sessions.executorApp?.threadId;
  const params = {
    cwd: input.paths.target,
    model: input.config.tools.executor.model ?? null,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    threadSource: 'user',
    sessionStartSource: 'startup'
  };
  if (existing) {
    const resumed = recordValue(await client.request('thread/resume', { threadId: existing, ...params }));
    const id = stringValue(recordValue(resumed?.thread)?.id);
    if (id) return id;
  }
  const started = recordValue(await client.request('thread/start', params));
  const id = stringValue(recordValue(started?.thread)?.id);
  if (!id) throw new Error('codex app-server thread/start did not return a thread id');
  return id;
}

async function readOutputSchema(): Promise<unknown> {
  return JSON.parse(await readFile(schemaPath('iter-result'), 'utf8')) as unknown;
}

class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private stderr = '';
  onNotification?: (message: JsonRpcMessage, raw: string) => Promise<void>;

  constructor(private readonly command: string, private readonly paths: RunPaths, private readonly effort?: string) {}

  async start(): Promise<void> {
    this.child = spawn(this.command, ['app-server', ...codexEffortArgs(this.effort), '--listen', 'stdio://'], {
      cwd: this.paths.target,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = tail(this.stderr + chunk, STDERR_TAIL_CHARS);
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      this.handleLine(line).catch((error: unknown) => {
        void appendFile(this.paths.supervisorLog, `[${nowIso()}] codex app-server handleLine error: ${error instanceof Error ? error.stack || error.message : String(error)}\n\n`).catch(() => undefined);
      });
    });
    this.child.once('exit', (code, signal) => {
      const message = `codex app-server exited code=${code ?? 'null'} signal=${signal ?? 'null'}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ''}`;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'wici',
        title: 'WiCi',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    this.notify('initialized');
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin.writable) throw new Error('codex app-server stdin is not writable');
    const id = this.nextId++;
    const payload = { method, id, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, 5_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.child?.stdin.writable) throw new Error('codex app-server stdin is not writable');
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async close(): Promise<void> {
    this.rl?.close();
    if (this.child && !this.child.killed) {
      this.child.stdin.end();
      this.child.kill('SIGTERM');
      setTimeout(() => this.child?.kill('SIGKILL'), 2_000).unref();
    }
  }

  private async handleLine(line: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      await appendFile(this.paths.codexRun, `${line}\n`);
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.respondToServerRequest(message);
      return;
    }

    await this.onNotification?.(message, line);
  }

  private respondToServerRequest(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable || message.id === undefined) return;
    const result = responseForServerRequest(message.method ?? '');
    this.child.stdin.write(`${JSON.stringify({ id: message.id, result })}\n`);
  }
}

function codexEffortArgs(effort: string | undefined): string[] {
  const normalized = effort?.trim();
  if (!normalized || normalized === 'default') return [];
  return ['-c', `model_reasoning_effort=${JSON.stringify(normalized)}`];
}

function responseForServerRequest(method: string): unknown {
  if (method === 'item/commandExecution/requestApproval') return { decision: 'decline' };
  if (method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'execCommandApproval') return { decision: 'denied' };
  if (method === 'applyPatchApproval') return { decision: 'denied' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn', strictAutoReview: true };
  return {};
}

function emptyUsageSummary(): ToolUsageSummary {
  return {
    events: 0,
    completed_turns: 0,
    completed_items: 0,
    failed: false,
    errors: []
  };
}

function mergeUsageSummary(base: ToolUsageSummary, delta: ToolUsageSummary): ToolUsageSummary {
  return {
    events: base.events + delta.events,
    completed_turns: base.completed_turns + delta.completed_turns,
    completed_items: base.completed_items + delta.completed_items,
    tokens_input: sumOptional(base.tokens_input, delta.tokens_input),
    tokens_output: sumOptional(base.tokens_output, delta.tokens_output),
    usd: sumOptional(base.usd, delta.usd),
    failed: base.failed || delta.failed,
    errors: [...base.errors, ...delta.errors].slice(-MAX_USAGE_ERRORS),
    parse_errors: sumOptional(base.parse_errors, delta.parse_errors)
  };
}

function cloneUsageSummary(summary: ToolUsageSummary): ToolUsageSummary {
  return {
    ...summary,
    errors: [...summary.errors]
  };
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}
