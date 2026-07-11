import { appendJsonLine, lineCount } from '../shared/atomic.js';
import type { RunEvent } from '../shared/types.js';

export class EventWriter {
  #seq = 0;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    this.#seq = await lineCount(this.path);
  }

  get seq(): number {
    return this.#seq;
  }

  async emit(type: string, message: string, data?: unknown, level: RunEvent['level'] = 'info'): Promise<RunEvent> {
    const event: RunEvent = {
      seq: ++this.#seq,
      ts: new Date().toISOString(),
      type,
      level,
      message,
      data
    };
    const write = this.#writeChain.then(() => appendJsonLine(this.path, event));
    this.#writeChain = write.catch(() => undefined);
    await write;
    await maybePauseForTest(type);
    return event;
  }
}

async function maybePauseForTest(type: string): Promise<void> {
  const spec = process.env.WICI_PAUSE_AFTER_EVENT;
  if (!spec) return;
  const [eventType, durationRaw] = spec.split(':');
  if (eventType !== type) return;
  const duration = Number(durationRaw);
  if (!Number.isFinite(duration) || duration <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, duration));
}
