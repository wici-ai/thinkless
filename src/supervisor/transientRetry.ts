export interface TransientRetryInfo {
  attempt: number;
  delayMs: number;
  reason: string;
}

const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 10 * 60_000;
const TRANSIENT_STATUS_CODES = [400, 502, 503, 524];

export function transientRetryDelayMs(): number {
  const raw = process.env.WICI_TRANSIENT_RETRY_DELAY_MS?.trim();
  if (!raw) return DEFAULT_TRANSIENT_RETRY_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TRANSIENT_RETRY_DELAY_MS;
}

export function isTransientNetworkFailure(text: string | undefined): boolean {
  const normalized = text?.trim();
  if (!normalized) return false;
  return TRANSIENT_STATUS_CODES.some((status) => transientStatusPattern(status).test(normalized)) ||
    /\b(server_error|bad gateway|gateway timeout|cloudflare.*timeout|temporarily unavailable|connection reset|socket hang up|econnreset|etimedout|at capacity|selected model is at capacity|try a different model)\b/i.test(normalized);
}

export function transientFailureReason(text: string | undefined): string {
  const normalized = text?.trim();
  if (!normalized) return 'transient network error';
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const interesting = lines.find((line) => isTransientNetworkFailure(line)) ?? lines.at(-1) ?? 'transient network error';
  return truncate(interesting.replace(/\s+/g, ' '), 500);
}

export function transientRetryMessage(tool: string, info: TransientRetryInfo): string {
  return `${tool} transient network failure; retry ${info.attempt + 1} in ${formatDelay(info.delayMs)}: ${info.reason}`;
}

export function formatDelay(ms: number): string {
  if (ms <= 0) return 'now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function transientStatusPattern(status: number): RegExp {
  return new RegExp(`(?:api[_ -]?error|http|status|error_status|unexpected status|response|request)[^\\n\\r]{0,120}\\b${status}\\b|\\b${status}\\b[^\\n\\r]{0,120}(?:api[_ -]?error|http|status|bad gateway|gateway timeout|timeout|server_error)`, 'i');
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
