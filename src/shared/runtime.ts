export type RuntimeAgent = 'claude' | 'codex';

export const RUNTIME_AGENTS: RuntimeAgent[] = ['claude', 'codex'];

export const RUNTIME_AGENT_MODELS: Record<RuntimeAgent, string> = {
  claude: 'opus4.8',
  codex: 'gpt5.5'
};

export const RUNTIME_AGENT_EFFORTS: Record<RuntimeAgent, string[]> = {
  claude: ['high', 'xhigh', 'max', 'ultracode'],
  codex: ['fast', 'medium', 'high', 'xhigh']
};

export const RUNTIME_AGENT_DEFAULT_EFFORT: Record<RuntimeAgent, string> = {
  claude: 'high',
  codex: 'medium'
};

export function isRuntimeAgent(value: string | undefined): value is RuntimeAgent {
  return value === 'claude' || value === 'codex';
}

export function runtimeAgentFromCommand(command: string | undefined, fallback: RuntimeAgent): RuntimeAgent {
  const normalized = command?.trim().toLowerCase();
  if (normalized === 'codex' || normalized?.endsWith('/codex')) return 'codex';
  if (normalized === 'claude' || normalized?.endsWith('/claude')) return 'claude';
  return fallback;
}

export function runtimeModelForAgent(agent: RuntimeAgent): string {
  return RUNTIME_AGENT_MODELS[agent];
}

export function defaultEffortForAgent(agent: RuntimeAgent): string {
  return RUNTIME_AGENT_DEFAULT_EFFORT[agent];
}

export function effortOptionsForAgent(agent: RuntimeAgent): string[] {
  return RUNTIME_AGENT_EFFORTS[agent];
}

export function normalizeEffortForAgent(agent: RuntimeAgent, effort: string | undefined): string {
  const normalized = effort?.trim();
  if (!normalized || normalized === 'default') return defaultEffortForAgent(agent);
  return effortOptionsForAgent(agent).includes(normalized) ? normalized : defaultEffortForAgent(agent);
}
