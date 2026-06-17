import {
  RUNTIME_AGENTS,
  defaultEffortForAgent,
  effortOptionsForAgent,
  isRuntimeAgent,
  normalizeEffortForAgent,
  runtimeAgentFromCommand,
  runtimeModelForAgent,
  type RuntimeAgent
} from '../shared/runtime.js';
import type { AgentRuntimeSelection, RuntimePane, RuntimeSelection } from '../shared/types.js';

export type RuntimeField = 'agent' | 'effort';

export const RUNTIME_FIELDS: RuntimeField[] = ['agent', 'effort'];

const DEFAULT_AGENTS: Record<RuntimePane, RuntimeAgent> = {
  chat: 'claude',
  planner: 'claude',
  executor: 'codex'
};

export function defaultRuntimeSelection(): RuntimeSelection {
  return {
    chat: runtimeDefaultsForAgent('claude'),
    planner: runtimeDefaultsForAgent('claude'),
    executor: runtimeDefaultsForAgent('codex')
  };
}

export function runtimePaneFromWorkspace(tab: 'chat' | 'plan' | 'execution'): RuntimePane {
  if (tab === 'plan') return 'planner';
  if (tab === 'execution') return 'executor';
  return 'chat';
}

export function runtimePaneLabel(pane: RuntimePane): string {
  if (pane === 'planner') return 'PLAN';
  if (pane === 'executor') return 'EXECUTION';
  return 'CHAT';
}

export function formatRuntimeSelection(selection: RuntimeSelection, pane: RuntimePane): string {
  const runtime = normalizedRuntime(selection, pane);
  return `${runtimePaneLabel(pane)} agent=${runtime.agent} model=${runtime.model} effort=${runtime.effort}`;
}

export function formatRuntimeSelectorLine(selection: RuntimeSelection, pane: RuntimePane, activeField: RuntimeField | null): string {
  const runtime = normalizedRuntime(selection, pane);
  const fields = RUNTIME_FIELDS.map((field) => {
    const text = `${field}=${runtime[field]}`;
    return activeField === field ? `[${text}]` : text;
  });
  return `${runtimePaneLabel(pane)} ${fields.join('  ')}  model=${runtime.model}`;
}

export function nextRuntimeField(field: RuntimeField): RuntimeField {
  const index = RUNTIME_FIELDS.indexOf(field);
  return RUNTIME_FIELDS[(index + 1) % RUNTIME_FIELDS.length];
}

export function previousRuntimeField(field: RuntimeField): RuntimeField {
  const index = RUNTIME_FIELDS.indexOf(field);
  return RUNTIME_FIELDS[(index + RUNTIME_FIELDS.length - 1) % RUNTIME_FIELDS.length];
}

export function cycleRuntimeValue(selection: RuntimeSelection, pane: RuntimePane, field: RuntimeField, direction: 1 | -1): RuntimeSelection {
  const current = normalizedRuntime(selection, pane)[field];
  const options = runtimeValueOptions(selection, pane, field);
  const index = options.indexOf(current);
  const nextIndex = index < 0 ? 0 : (index + direction + options.length) % options.length;
  return updateRuntimeSelection(selection, pane, field, options[nextIndex]);
}

export function parseRuntimeCommand(text: string, current: RuntimeSelection): { next: RuntimeSelection; status: string } | null {
  const match = /^\/(agent|model|effort)\s+(\S+)\s+(.+?)\s*$/i.exec(text.trim());
  if (!match) return null;
  const command = match[1].toLowerCase();
  const pane = parseRuntimePane(match[2]);
  if (!pane) {
    return {
      next: current,
      status: `unknown runtime pane: ${match[2]}`
    };
  }
  if (command === 'model') {
    return {
      next: current,
      status: 'model is fixed by agent: claude=opus4.8 codex=gpt5.5'
    };
  }

  const field = command as RuntimeField;
  const rawValue = match[3].trim().toLowerCase();
  if (!rawValue) {
    return {
      next: current,
      status: `${field} value is required`
    };
  }

  const currentAgent = normalizedRuntime(current, pane).agent as RuntimeAgent;
  if (field === 'agent' && !isRuntimeAgent(rawValue)) {
    return {
      next: current,
      status: `unknown agent: ${rawValue}`
    };
  }
  if (field === 'effort' && rawValue !== 'default' && !effortOptionsForAgent(currentAgent).includes(rawValue)) {
    return {
      next: current,
      status: `unknown effort for ${currentAgent}: ${rawValue}`
    };
  }

  const value = normalizeRuntimeValue(pane, field, rawValue, currentAgent);
  const next = updateRuntimeSelection(current, pane, field, value);
  return {
    next,
    status: formatRuntimeSelection(next, pane)
  };
}

function parseRuntimePane(raw: string): RuntimePane | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'chat') return 'chat';
  if (normalized === 'plan' || normalized === 'planner') return 'planner';
  if (normalized === 'execution' || normalized === 'exec' || normalized === 'executor') return 'executor';
  return null;
}

function updateRuntimeSelection(selection: RuntimeSelection, pane: RuntimePane, field: RuntimeField, value: string): RuntimeSelection {
  if (field === 'agent') {
    const agent = isRuntimeAgent(value) ? value : DEFAULT_AGENTS[pane];
    return {
      ...selection,
      [pane]: runtimeDefaultsForAgent(agent)
    };
  }

  const current = normalizedRuntime(selection, pane);
  const agent = current.agent as RuntimeAgent;
  return {
    ...selection,
    [pane]: {
      ...current,
      model: runtimeModelForAgent(agent),
      effort: normalizeEffortForAgent(agent, value)
    }
  };
}

function runtimeValueOptions(selection: RuntimeSelection, pane: RuntimePane, field: RuntimeField): string[] {
  const currentAgent = normalizedRuntime(selection, pane).agent as RuntimeAgent;
  return field === 'agent' ? RUNTIME_AGENTS : effortOptionsForAgent(currentAgent);
}

function normalizedRuntime(selection: RuntimeSelection, pane: RuntimePane): Required<AgentRuntimeSelection> {
  const runtime = selection[pane] ?? {};
  const agent = isRuntimeAgent(runtime.agent) ? runtime.agent : runtimeAgentFromCommand(runtime.agent, DEFAULT_AGENTS[pane]);
  return {
    agent,
    model: runtimeModelForAgent(agent),
    effort: normalizeEffortForAgent(agent, runtime.effort)
  };
}

function normalizeRuntimeValue(pane: RuntimePane, field: RuntimeField, raw: string, currentAgent: RuntimeAgent): string {
  const normalized = raw.trim();
  if (field === 'agent' && normalized === 'default') return DEFAULT_AGENTS[pane];
  if (field === 'effort' && normalized === 'default') return defaultEffortForAgent(currentAgent);
  return normalized;
}

function runtimeDefaultsForAgent(agent: RuntimeAgent): Required<AgentRuntimeSelection> {
  return {
    agent,
    model: runtimeModelForAgent(agent),
    effort: defaultEffortForAgent(agent)
  };
}
