import { readFile } from 'node:fs/promises';
import { exists, readJsonFile } from './atomic.js';
import { TOOL_ROOT } from './paths.js';
import type { AgentRuntimeSelection, RuntimeSelection, ToolMode, WiCiConfig } from './types.js';
import { join, resolve } from 'node:path';
import {
  defaultEffortForAgent,
  isRuntimeAgent,
  normalizeEffortForAgent,
  runtimeAgentFromCommand,
  runtimeModelForAgent,
  type RuntimeAgent
} from './runtime.js';

export async function loadConfig(modeOverride?: ToolMode): Promise<WiCiConfig> {
  const path = resolve(join(TOOL_ROOT, 'wici.config.json'));
  if (!(await exists(path))) {
    throw new Error(`Missing WiCi config: ${path}`);
  }
  const config = await readJsonFile<WiCiConfig>(path);
  normalizeToolConfig(config);
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
  applyRuntimeSelection(config, {
    chat: envRuntime('WICI_CHAT'),
    planner: envRuntime('WICI_PLANNER'),
    executor: envRuntime('WICI_EXECUTOR')
  });
  if (process.env.WICI_CODEX_EFFORT?.trim()) {
    config.tools.executor.effort = process.env.WICI_CODEX_EFFORT.trim();
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

export function normalizeToolConfig(config: WiCiConfig): WiCiConfig {
  config.tools.chat ??= {};
  config.tools.chat.command = normalizeDefault(config.tools.chat.command) ?? config.tools.planner.command;
  normalizeAgentTool(config.tools.chat, 'claude');
  normalizeAgentTool(config.tools.planner, 'codex', 'xhigh');
  normalizeAgentTool(config.tools.executor, 'codex');
  return config;
}

export function applyRuntimeSelection(config: WiCiConfig, runtime?: RuntimeSelection): WiCiConfig {
  normalizeToolConfig(config);
  applyAgentRuntime(config.tools.chat!, runtime?.chat, 'claude');
  applyAgentRuntime(config.tools.planner, runtime?.planner, 'codex', 'xhigh');
  applyAgentRuntime(config.tools.executor, runtime?.executor, 'codex');
  return config;
}

function applyAgentRuntime(target: { command?: string; model?: string; effort?: string }, runtime: AgentRuntimeSelection | undefined, fallback: RuntimeAgent, defaultEffort?: string): void {
  if (!runtime?.agent && !runtime?.effort) return;
  const selectedAgent = normalizeDefault(runtime?.agent);
  const currentAgent = runtimeAgentFromCommand(target.command, fallback);
  const agent = isRuntimeAgent(selectedAgent) ? selectedAgent : currentAgent;
  if (selectedAgent && !isRuntimeAgent(selectedAgent)) {
    throw new Error(`Unknown runtime agent: ${selectedAgent}. Expected claude or codex.`);
  }
  if (selectedAgent) target.command = agent;
  target.model = runtimeModelForAgent(agent);
  target.effort = normalizeEffortForAgent(agent, runtime?.effort ?? target.effort ?? (agent === 'codex' ? defaultEffort : undefined));
}

function envRuntime(prefix: 'WICI_CHAT' | 'WICI_PLANNER' | 'WICI_EXECUTOR'): AgentRuntimeSelection | undefined {
  const runtime: AgentRuntimeSelection = {
    agent: process.env[`${prefix}_AGENT`] ?? process.env[`${prefix}_COMMAND`],
    effort: process.env[`${prefix}_EFFORT`]
  };
  return runtime.agent || runtime.effort ? runtime : undefined;
}

function normalizeDefault(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === 'default') return undefined;
  return normalized;
}

function normalizeAgentTool(target: { command?: string; model?: string; effort?: string }, fallback: RuntimeAgent, defaultEffort?: string): void {
  const agent = runtimeAgentFromCommand(target.command, fallback);
  target.command = target.command?.trim() || agent;
  target.model = runtimeModelForAgent(agent);
  target.effort = normalizeEffortForAgent(agent, target.effort ?? (agent === 'codex' ? defaultEffort : undefined) ?? defaultEffortForAgent(agent));
}

export async function readTextIfExists(path: string): Promise<string> {
  if (!(await exists(path))) return '';
  return readFile(path, 'utf8');
}
