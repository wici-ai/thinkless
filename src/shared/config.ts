import { readFile } from 'node:fs/promises';
import { exists, readJsonFile } from './atomic.js';
import { TOOL_ROOT } from './paths.js';
import type { ToolMode, WiCiConfig } from './types.js';
import { join, resolve } from 'node:path';

export async function loadConfig(modeOverride?: ToolMode): Promise<WiCiConfig> {
  const path = resolve(join(TOOL_ROOT, 'wici.config.json'));
  if (!(await exists(path))) {
    throw new Error(`Missing WiCi config: ${path}`);
  }
  const config = await readJsonFile<WiCiConfig>(path);
  config.retry ??= {
    max_attempts_per_step: 2,
    reverts_before_reset: 5,
    stall_replan_after: 3
  };
  config.diversity ??= {
    avenues: ['algorithmic complexity', 'data structure change', 'caching or memoization', 'batching or I/O reduction', 'concurrency or parallelism']
  };
  config.evaluation.lock_mode ??= 'auto';
  if (modeOverride) config.tools.mode = modeOverride;
  if (process.env.WICI_TOOL_MODE === 'real' || process.env.WICI_TOOL_MODE === 'auto' || process.env.WICI_TOOL_MODE === 'stub') {
    config.tools.mode = process.env.WICI_TOOL_MODE;
  }
  return config;
}

export async function readTextIfExists(path: string): Promise<string> {
  if (!(await exists(path))) return '';
  return readFile(path, 'utf8');
}
