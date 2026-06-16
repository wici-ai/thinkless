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
  config.tools.auto_update ??= true;
  config.retry ??= {
    max_attempts_per_step: 2,
    reverts_before_reset: 5,
    stall_replan_after: 3
  };
  config.evaluation.lock_mode ??= 'auto';
  config.evaluation.legacy_optimizer ??= false;
  if (modeOverride) config.tools.mode = modeOverride;
  if (process.env.WICI_TOOL_MODE === 'real' || process.env.WICI_TOOL_MODE === 'auto' || process.env.WICI_TOOL_MODE === 'stub') {
    config.tools.mode = process.env.WICI_TOOL_MODE;
  }
  if (process.env.WICI_AUTO_UPDATE_TOOLS === '0') {
    config.tools.auto_update = false;
  }
  if (process.env.WICI_AUTO_UPDATE_TOOLS === '1') {
    config.tools.auto_update = true;
  }
  if (process.env.WICI_LEGACY_OPTIMIZER === '1') {
    config.evaluation.legacy_optimizer = true;
  }
  if (process.env.WICI_CODEX_MODEL?.trim()) {
    config.tools.executor.model = process.env.WICI_CODEX_MODEL.trim();
  }
  if (
    process.env.WICI_CODEX_EXECUTOR_BACKEND === 'auto' ||
    process.env.WICI_CODEX_EXECUTOR_BACKEND === 'app-server' ||
    process.env.WICI_CODEX_EXECUTOR_BACKEND === 'exec'
  ) {
    config.tools.executor.backend = process.env.WICI_CODEX_EXECUTOR_BACKEND;
  }
  return config;
}

export async function readTextIfExists(path: string): Promise<string> {
  if (!(await exists(path))) return '';
  return readFile(path, 'utf8');
}
