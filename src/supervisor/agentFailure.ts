const USAGE_LIMIT_PATTERN = /\b(?:you(?:'|’)ve hit your usage limit|agent usage limit reached|usage limit (?:has been )?reached|purchase more credits|out of credits|insufficient credits)\b/i;
const CYBERSECURITY_POLICY_PATTERN = /(?:content was flagged for possible cybersecurity risk|trusted access for cyber)/i;

export function isToolUsageLimitFailure(error: unknown): boolean {
  return terminalFailureMessages(error).some((message) => USAGE_LIMIT_PATTERN.test(message));
}

export function toolUsageLimitReason(error: unknown): string {
  const matched = terminalFailureMessages(error).find((message) => USAGE_LIMIT_PATTERN.test(message)) ?? 'Agent usage limit reached.';
  return truncate(matched.replace(/\s+/g, ' '), 600);
}

export function isToolCybersecurityPolicyFailure(error: unknown): boolean {
  return terminalFailureMessages(error).some((message) => CYBERSECURITY_POLICY_PATTERN.test(message));
}

export function toolCybersecurityPolicyReason(error: unknown): string {
  const matched = terminalFailureMessages(error).find((message) => CYBERSECURITY_POLICY_PATTERN.test(message));
  if (!matched) return 'Codex safety policy refused the executor turn as possible cybersecurity risk.';
  return 'Codex safety policy refused the executor turn as possible cybersecurity risk.';
}

export function crashFailureSignature(text: string | undefined): string {
  return (text ?? '')
    .replace(/"thread_id"\s*:\s*"[^"]+"/gi, '"thread_id":"thread#"')
    .replace(/"turn_id"\s*:\s*"[^"]+"/gi, '"turn_id":"turn#"')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, 'uuid#')
    .replace(/\b(?:thread|turn|request|item)[-_ ]?(?:id)?[-_ :="]+[0-9a-z-]+/gi, 'runtime-id#')
    .replace(/\b\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z\b/gi, 'timestamp#')
    .replace(/\b(?:iter(?:ation)?|attempt)[-_ :]*\d+\b/gi, 'attempt#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function terminalFailureMessages(error: unknown): string[] {
  if (isRecord(error)) {
    const usageErrors = usageFailureMessages(error.usage);
    if (usageErrors.length > 0) return usageErrors;
    if (error.cause !== undefined) {
      const causeErrors = terminalFailureMessages(error.cause);
      if (causeErrors.length > 0) return causeErrors;
    }
    if (typeof error.message === 'string') return terminalFailureMessages(error.message);
  }
  if (typeof error !== 'string') return [];

  const structured = error
    .split(/\r?\n/)
    .map((line) => structuredTerminalMessage(line.trim()))
    .filter((message): message is string => Boolean(message));
  if (structured.length > 0) return structured;

  const direct = error.trim();
  return direct && !/[\r\n]/.test(direct) && direct.length <= 2_000 ? [direct] : [];
}

function usageFailureMessages(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.errors)) return [];
  return value.errors.filter((message): message is string => typeof message === 'string' && message.trim().length > 0);
}

function structuredTerminalMessage(line: string): string | null {
  if (!line.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;
    const type = typeof parsed.type === 'string' ? parsed.type : typeof parsed.method === 'string' ? parsed.method : '';
    if (type !== 'error' && type !== 'turn.failed' && type !== 'turn/failed') return null;
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.error === 'string') return parsed.error;
    if (isRecord(parsed.error) && typeof parsed.error.message === 'string') return parsed.error.message;
    if (isRecord(parsed.data) && typeof parsed.data.message === 'string') return parsed.data.message;
    return null;
  } catch {
    return null;
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
