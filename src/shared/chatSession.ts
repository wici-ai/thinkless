import { atomicWriteJson, readJsonFileMaybe } from './atomic.js';
import type { AgentRuntimeSelection, RuntimeSelection } from './types.js';
import type { RunPaths } from './paths.js';
import {
  defaultEffortForAgent,
  isRuntimeAgent,
  normalizeEffortForAgent,
  runtimeAgentFromCommand,
  runtimeModelForAgent,
  type RuntimeAgent
} from './runtime.js';

export type ChatSessionAgent = 'claude' | 'codex';

interface ChatSessionEntry {
  session_id?: string;
  updated_at?: string;
  runtime?: AgentRuntimeSelection;
}

export interface ChatSessionFile {
  session_id?: string;
  updated_at?: string;
  runtime_selection?: RuntimeSelection;
  sessions?: Partial<Record<ChatSessionAgent, ChatSessionEntry>>;
}

export async function readChatSession(paths: RunPaths, agent: ChatSessionAgent): Promise<string | undefined> {
  const data = await readChatSessionFile(paths);
  return data?.sessions?.[agent]?.session_id ?? (agent === 'claude' ? data?.session_id : undefined);
}

export async function writeChatSession(paths: RunPaths, agent: ChatSessionAgent, sessionId: string, runtime?: AgentRuntimeSelection): Promise<void> {
  const current = (await readChatSessionFile(paths)) ?? {};
  const updatedAt = timestamp();
  const normalizedRuntime = runtime ? normalizeAgentRuntime(runtime, agent) : current.sessions?.[agent]?.runtime;
  await atomicWriteJson(paths.chatSession, {
    ...current,
    ...(agent === 'claude' ? { session_id: sessionId } : {}),
    updated_at: updatedAt,
    ...(normalizedRuntime
      ? {
          runtime_selection: {
            ...(current.runtime_selection ?? {}),
            chat: normalizedRuntime
          }
        }
      : {}),
    sessions: {
      ...(current.sessions ?? {}),
      [agent]: {
        session_id: sessionId,
        updated_at: updatedAt,
        ...(normalizedRuntime ? { runtime: normalizedRuntime } : {})
      }
    }
  });
}

export async function readPersistedRuntimeSelection(paths: RunPaths): Promise<RuntimeSelection | undefined> {
  const data = await readChatSessionFile(paths);
  if (!data) return undefined;
  if (data.runtime_selection) return normalizeRuntimeSelection(data.runtime_selection);
  const chat = latestChatRuntime(data);
  return chat ? { chat } : undefined;
}

export async function writePersistedRuntimeSelection(paths: RunPaths, runtime: RuntimeSelection): Promise<void> {
  const current = (await readChatSessionFile(paths)) ?? {};
  await atomicWriteJson(paths.chatSession, {
    ...current,
    updated_at: timestamp(),
    runtime_selection: normalizeRuntimeSelection(runtime)
  });
}

async function readChatSessionFile(paths: RunPaths): Promise<ChatSessionFile | null> {
  return readJsonFileMaybe<ChatSessionFile>(paths.chatSession);
}

function latestChatRuntime(data: ChatSessionFile): AgentRuntimeSelection | undefined {
  const entries = Object.entries(data.sessions ?? {})
    .filter((item): item is [ChatSessionAgent, ChatSessionEntry] => isChatSessionAgent(item[0]) && Boolean(item[1]?.session_id))
    .sort((a, b) => timestampValue(b[1].updated_at) - timestampValue(a[1].updated_at));
  const [agent, entry] = entries[0] ?? [];
  if (agent) return normalizeAgentRuntime(entry?.runtime ?? { agent }, agent);
  if (data.session_id) return normalizeAgentRuntime({ agent: 'claude' }, 'claude');
  return undefined;
}

function normalizeRuntimeSelection(selection: RuntimeSelection): RuntimeSelection {
  return {
    chat: normalizeAgentRuntime(selection.chat, 'claude'),
    planner: normalizeAgentRuntime(selection.planner, 'claude'),
    executor: normalizeAgentRuntime(selection.executor, 'codex')
  };
}

function normalizeAgentRuntime(runtime: AgentRuntimeSelection | undefined, fallback: RuntimeAgent): Required<AgentRuntimeSelection> {
  const selected = runtime?.agent?.trim();
  const agent = isRuntimeAgent(selected) ? selected : runtimeAgentFromCommand(selected, fallback);
  return {
    agent,
    model: runtimeModelForAgent(agent),
    effort: normalizeEffortForAgent(agent, runtime?.effort ?? defaultEffortForAgent(agent))
  };
}

function isChatSessionAgent(value: string): value is ChatSessionAgent {
  return value === 'claude' || value === 'codex';
}

function timestampValue(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(): string {
  return new Date().toISOString();
}
