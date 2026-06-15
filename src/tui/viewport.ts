export interface TextViewport {
  lines: string[];
  start: number;
  end: number;
  maxScroll: number;
}

export const PAGE_SIZE = 8;

export function wrapLines(lines: string[], width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const output: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      output.push('');
      continue;
    }
    for (let index = 0; index < line.length; index += limit) {
      output.push(line.slice(index, index + limit));
    }
  }
  return output;
}

export function viewport(lines: string[], scrollOffset: number, size: number): TextViewport {
  if (lines.length === 0 || size <= 0) {
    return { lines: [], start: 0, end: 0, maxScroll: 0 };
  }
  const maxScroll = Math.max(0, lines.length - size);
  const clampedOffset = Math.min(Math.max(0, scrollOffset), maxScroll);
  const end = Math.max(0, lines.length - clampedOffset);
  const start = Math.max(0, end - size);
  return {
    lines: lines.slice(start, end),
    start,
    end,
    maxScroll
  };
}

export function scrollBy(current: number, delta: number, maxScroll: number): number {
  return Math.min(maxScroll, Math.max(0, current + delta));
}
