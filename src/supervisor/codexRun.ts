import { appendFile } from 'node:fs/promises';
import type { RunPaths } from '../shared/paths.js';
import type { ToolUsageSummary } from '../shared/types.js';

export class CodexRunError extends Error {
  readonly usage: ToolUsageSummary;

  constructor(message: string, usage: ToolUsageSummary) {
    super(message);
    this.name = 'CodexRunError';
    this.usage = usage;
  }
}

export async function appendCodexRunTranscript(paths: RunPaths, raw: string): Promise<ToolUsageSummary> {
  if (raw.trim()) {
    await appendFile(paths.codexRun, raw.endsWith('\n') ? raw : `${raw}\n`);
  }
  return parseCodexRunEvents(raw);
}

export function parseCodexRunEvents(raw: string): ToolUsageSummary {
  const summary: ToolUsageSummary = {
    events: 0,
    completed_turns: 0,
    completed_items: 0,
    failed: false,
    errors: []
  };

  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      summary.parse_errors = (summary.parse_errors ?? 0) + 1;
      continue;
    }
    if (!isRecord(event)) continue;
    summary.events += 1;

    const type = eventType(event);
    if (type === 'turn.completed') {
      summary.completed_turns += 1;
      addUsage(summary, usageFrom(event));
    } else if (type === 'item.completed') {
      summary.completed_items += 1;
    } else if (type === 'turn.failed' || type === 'error' || hasTopLevelError(event)) {
      summary.failed = true;
      summary.errors.push(errorMessage(event));
    }
  }

  return compactSummary(summary);
}

export function assertCodexRunSucceeded(summary: ToolUsageSummary, context: string): void {
  if (!summary.failed) return;
  const errors = summary.errors.length > 0 ? summary.errors.join('; ') : 'unknown Codex run failure';
  throw new CodexRunError(`${context}: ${errors}`, summary);
}

export function codexUsageFromError(error: unknown): ToolUsageSummary | undefined {
  return error instanceof CodexRunError ? error.usage : undefined;
}

export function syntheticCodexRunEvent(iter: number, notes: string): string {
  const input = 120 + iter * 7;
  const output = Math.max(20, Math.ceil(notes.length / 4));
  return [
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output
      }
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'message',
        iter
      }
    })
  ].join('\n');
}

function addUsage(summary: ToolUsageSummary, usage: Record<string, unknown> | null): void {
  if (!usage) return;
  const input = firstNumber(usage, ['input_tokens', 'prompt_tokens', 'input']);
  const output = firstNumber(usage, ['output_tokens', 'completion_tokens', 'output']);
  const usd = firstNumber(usage, ['usd', 'cost_usd', 'total_cost_usd']);
  if (input !== undefined) summary.tokens_input = (summary.tokens_input ?? 0) + input;
  if (output !== undefined) summary.tokens_output = (summary.tokens_output ?? 0) + output;
  if (usd !== undefined) summary.usd = Number(((summary.usd ?? 0) + usd).toFixed(8));
}

function usageFrom(event: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(event.usage)) return event.usage;
  if (isRecord(event.data) && isRecord(event.data.usage)) return event.data.usage;
  if (isRecord(event.item) && isRecord(event.item.usage)) return event.item.usage;
  return null;
}

function eventType(event: Record<string, unknown>): string {
  for (const key of ['type', 'event', 'name']) {
    const value = event[key];
    if (typeof value === 'string') return value;
  }
  if (isRecord(event.item) && typeof event.item.type === 'string') return event.item.type;
  return '';
}

function hasTopLevelError(event: Record<string, unknown>): boolean {
  return event.error !== undefined && eventType(event) !== 'item.completed';
}

function errorMessage(event: Record<string, unknown>): string {
  if (typeof event.message === 'string') return event.message;
  if (typeof event.error === 'string') return event.error;
  if (isRecord(event.error) && typeof event.error.message === 'string') return event.error.message;
  if (isRecord(event.data) && typeof event.data.message === 'string') return event.data.message;
  return JSON.stringify(event);
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function compactSummary(summary: ToolUsageSummary): ToolUsageSummary {
  if (summary.tokens_input === 0) delete summary.tokens_input;
  if (summary.tokens_output === 0) delete summary.tokens_output;
  if (summary.usd === 0) delete summary.usd;
  return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
