const USAGE_LIMIT_PATTERN = /\b(?:you(?:'|’)ve hit your usage limit|usage limit|purchase more credits|out of credits|insufficient credits)\b/i;

export function isToolUsageLimitFailure(text: string | undefined): boolean {
  return Boolean(text && USAGE_LIMIT_PATTERN.test(text));
}

export function toolUsageLimitReason(text: string | undefined): string {
  const lines = (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const matched = lines.find((line) => USAGE_LIMIT_PATTERN.test(line)) ?? 'Agent usage limit reached.';
  const decoded = decodeJsonMessage(matched);
  return truncate(decoded.replace(/\s+/g, ' '), 600);
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

function decodeJsonMessage(line: string): string {
  try {
    const parsed = JSON.parse(line) as { message?: unknown; error?: { message?: unknown } };
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.error?.message === 'string') return parsed.error.message;
  } catch {
    // Preserve the useful source line when it is not a standalone JSON object.
  }
  const messageMatch = line.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!messageMatch) return line;
  try {
    return JSON.parse(`"${messageMatch[1]}"`) as string;
  } catch {
    return messageMatch[1];
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
