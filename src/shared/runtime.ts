export type RuntimeAgent = 'claude' | 'codex';

export const RUNTIME_AGENTS: RuntimeAgent[] = ['claude', 'codex'];

export const RUNTIME_AGENT_MODELS: Record<RuntimeAgent, string> = {
  claude: 'claude-opus-4-8',
  codex: 'gpt-5.6-sol'
};

export const RUNTIME_AGENT_MODEL_OPTIONS: Record<RuntimeAgent, string[]> = {
  claude: ['claude-opus-4-8'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']
};

export const RUNTIME_AGENT_EFFORTS: Record<RuntimeAgent, string[]> = {
  claude: ['high', 'xhigh', 'max', 'ultracode'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
};

export const RUNTIME_MODEL_EFFORTS: Record<string, string[]> = {
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh']
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
  const basename = normalized?.split(/[\\/]/).at(-1)?.replace(/\.(?:cmd|exe|bat|ps1)$/i, '');
  if (basename === 'codex') return 'codex';
  if (basename === 'claude') return 'claude';
  return fallback;
}

export function runtimeModelForAgent(agent: RuntimeAgent): string {
  return RUNTIME_AGENT_MODELS[agent];
}

export function modelOptionsForAgent(agent: RuntimeAgent): string[] {
  return RUNTIME_AGENT_MODEL_OPTIONS[agent];
}

export function isModelForAgent(agent: RuntimeAgent, model: string | undefined): boolean {
  return Boolean(model && modelOptionsForAgent(agent).includes(model.trim().toLowerCase()));
}

export function normalizeModelForAgent(agent: RuntimeAgent, model: string | undefined): string {
  const normalized = model?.trim().toLowerCase();
  return isModelForAgent(agent, normalized) ? normalized! : runtimeModelForAgent(agent);
}

export function defaultEffortForAgent(agent: RuntimeAgent): string {
  return RUNTIME_AGENT_DEFAULT_EFFORT[agent];
}

export function effortOptionsForAgent(agent: RuntimeAgent, model?: string): string[] {
  if (agent === 'codex') return RUNTIME_MODEL_EFFORTS[normalizeModelForAgent(agent, model)];
  return RUNTIME_AGENT_EFFORTS[agent];
}

export function normalizeEffortForAgent(agent: RuntimeAgent, effort: string | undefined, model?: string): string {
  const normalized = effort?.trim();
  if (!normalized || normalized === 'default') return defaultEffortForAgent(agent);
  return effortOptionsForAgent(agent, model).includes(normalized) ? normalized : defaultEffortForAgent(agent);
}
