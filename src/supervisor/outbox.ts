import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { atomicWriteJson, ensureDir, exists, readJsonFile } from '../shared/atomic.js';
import type { RunPaths } from '../shared/paths.js';
import type { OutboxKind, OutboxMessage } from '../shared/types.js';

export async function writeOutbox(paths: RunPaths, input: { kind: OutboxKind; text: string; replyKey?: string; data?: unknown }): Promise<OutboxMessage> {
  await ensureDir(paths.outbox);
  const message: OutboxMessage = {
    id: `out-${Date.now()}-${randomUUID().slice(0, 8)}`,
    ts: new Date().toISOString(),
    kind: input.kind,
    text: input.text,
    reply_key: input.replyKey,
    answered: false,
    data: input.data
  };
  await atomicWriteJson(join(paths.outbox, `${message.id}.json`), message);
  return message;
}

export async function readOutbox(paths: RunPaths, limit = 20): Promise<OutboxMessage[]> {
  if (!(await exists(paths.outbox))) return [];
  const names = (await readdir(paths.outbox)).filter((name) => /^out-.+\.json$/.test(name)).sort();
  const selected = names.slice(-limit);
  return Promise.all(selected.map((name) => readJsonFile<OutboxMessage>(join(paths.outbox, name))));
}

export async function markOutboxAnswered(paths: RunPaths, replyKey: string, answerText: string): Promise<OutboxMessage | null> {
  if (!(await exists(paths.outbox))) return null;
  const names = (await readdir(paths.outbox)).filter((name) => /^out-.+\.json$/.test(name)).sort();
  for (const name of names) {
    const path = join(paths.outbox, name);
    const message = await readJsonFile<OutboxMessage>(path);
    if (message.reply_key !== replyKey) continue;
    const next: OutboxMessage = {
      ...message,
      answered: true,
      answer_text: answerText,
      answered_at: new Date().toISOString()
    };
    await atomicWriteJson(path, next);
    return next;
  }
  return null;
}
