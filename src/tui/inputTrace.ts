import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runPaths } from '../shared/paths.js';

const MAX_TRACE_EVENTS = 2000;

export function installTuiInputTrace(target: string, stdin: NodeJS.ReadStream = process.stdin): () => void {
  if (process.env.WICI_TUI_INPUT_TRACE !== '1' || !stdin.isTTY) return () => undefined;
  const tracePath = join(runPaths(target).wici, 'tui-input.jsonl');
  mkdirSync(dirname(tracePath), { recursive: true });
  let events = 0;
  const append = (record: Record<string, unknown>) => {
    if (events >= MAX_TRACE_EVENTS) return;
    events += 1;
    appendFileSync(tracePath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8');
  };
  append({
    type: 'trace_start',
    term: process.env.TERM,
    term_program: process.env.TERM_PROGRAM
  });
  const onData = (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const text = buffer.toString('utf8');
    if (!shouldTraceInput(text)) return;
    append({
      type: 'input',
      bytes_hex: [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
      escaped: escapeInput(text),
      length: buffer.length
    });
  };
  stdin.on('data', onData);
  const cleanup = () => {
    stdin.off('data', onData);
  };
  process.once('exit', cleanup);
  return cleanup;
}

export function shouldTraceInput(input: string): boolean {
  return input.includes('\x1b') || input.includes('[<') || input.includes('[M') || /\[[0-9;?]*[A-Za-z~]/.test(input);
}

function escapeInput(input: string): string {
  return input
    .replace(/\x1b/g, '\\x1b')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[^\x20-\x7e]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
