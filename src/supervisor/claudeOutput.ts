export interface ClaudeUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
}

export interface ClaudeJsonEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  session_id?: string;
  message?: {
    usage?: ClaudeUsage;
  };
  usage?: ClaudeUsage;
  total_cost_usd?: number;
  permission_denials?: unknown[];
}

export function parseClaudeJsonOutput(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Claude produced empty output');
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed: unknown[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      if (lines.length === 1) throw new Error(`Claude produced invalid JSON: ${line.slice(0, 4000)}`);
    }
  }
  if (parsed.length > 0) return parsed;
  return [JSON.parse(trimmed)];
}

export function isClaudeEnvelope(value: unknown): value is ClaudeJsonEnvelope {
  return Boolean(value && typeof value === 'object' && ('type' in value || 'result' in value || 'message' in value));
}

export function parseJsonObjectFromText(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const fenced of fencedBlocks(trimmed)) {
      const parsed = parseJsonCandidate(fenced);
      if (parsed !== null) return parsed;
    }
    return parseBalancedJsonObject(trimmed);
  }
}

function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split(/\r?\n/);
  let collecting = false;
  let buffer: string[] = [];

  for (const line of lines) {
    if (!collecting) {
      if (/^\s*```(?:json)?\s*$/i.test(line)) {
        collecting = true;
        buffer = [];
      }
      continue;
    }

    if (/^\s*```\s*$/.test(line)) {
      blocks.push(buffer.join('\n').trim());
      collecting = false;
      buffer = [];
      continue;
    }

    buffer.push(line);
  }

  return blocks;
}

function parseJsonCandidate(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return parseBalancedJsonObject(trimmed);
  }
}

function parseBalancedJsonObject(text: string): unknown | null {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = balancedObjectEnd(text, start);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return null;
}

function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }

  return -1;
}
