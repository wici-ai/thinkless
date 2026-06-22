import { execa } from 'execa';

const DEFAULT_DICTATION_TIMEOUT_MS = 120_000;

export interface DictationRequest {
  submit: boolean;
  command: string | null;
}

export interface DictationResult {
  text: string;
  wordCount: number;
}

export function parseDictationRequest(text: string, env: NodeJS.ProcessEnv = process.env): DictationRequest | null {
  const normalized = text.trim();
  if (normalized !== '/dictate' && normalized !== '/dictate submit') return null;
  return {
    submit: normalized.endsWith(' submit'),
    command: env.WICI_DICTATION_COMMAND?.trim() || null
  };
}

export function dictationUnavailableMessage(): string {
  return 'dictation: set WICI_DICTATION_COMMAND to a local speech-to-text command';
}

export async function runDictationCommand(command: string, options: { timeoutMs?: number } = {}): Promise<DictationResult> {
  const result = await execa('sh', ['-c', command], {
    all: true,
    timeout: options.timeoutMs ?? DEFAULT_DICTATION_TIMEOUT_MS,
    reject: true
  });
  const text = normalizeTranscript(result.stdout || result.all || '');
  return {
    text,
    wordCount: text ? text.split(/\s+/).length : 0
  };
}

export function appendDictationText(current: string, transcript: string): string {
  const left = current.trimEnd();
  const right = normalizeTranscript(transcript);
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
