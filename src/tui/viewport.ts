export interface TextViewport<T = string> {
  lines: T[];
  start: number;
  end: number;
  maxScroll: number;
  total: number;
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

export function viewport<T = string>(lines: T[], scrollOffset: number, size: number): TextViewport<T> {
  if (lines.length === 0 || size <= 0) {
    return { lines: [], start: 0, end: 0, maxScroll: 0, total: lines.length };
  }
  const maxScroll = Math.max(0, lines.length - size);
  const clampedOffset = Math.min(Math.max(0, scrollOffset), maxScroll);
  const end = Math.max(0, lines.length - clampedOffset);
  const start = Math.max(0, end - size);
  return {
    lines: lines.slice(start, end),
    start,
    end,
    maxScroll,
    total: lines.length
  };
}

export function wrappedViewport<T = string>(
  lines: T[],
  width: number,
  scrollOffset: number,
  size: number,
  textOf: (line: T) => string = (line) => String(line),
  withText: (line: T, text: string, wrapIndex: number) => T = (_line, text) => text as T
): TextViewport<T> {
  const limit = Math.max(1, Math.floor(width));
  const total = lines.reduce((count, line) => count + wrappedLineCount(textOf(line), limit), 0);
  if (total === 0 || size <= 0) return { lines: [], start: 0, end: 0, maxScroll: 0, total };

  const maxScroll = Math.max(0, total - size);
  const clampedOffset = Math.min(Math.max(0, scrollOffset), maxScroll);
  const end = Math.max(0, total - clampedOffset);
  const start = Math.max(0, end - size);
  const visible: T[] = [];
  let cursor = 0;

  for (const line of lines) {
    const text = textOf(line);
    const count = wrappedLineCount(text, limit);
    const lineStart = cursor;
    const lineEnd = cursor + count;
    cursor = lineEnd;
    if (lineEnd <= start) continue;
    if (lineStart >= end) break;

    const first = Math.max(0, start - lineStart);
    const last = Math.min(count, end - lineStart);
    for (let index = first; index < last; index += 1) {
      visible.push(withText(line, wrappedTextAt(text, limit, index), index));
    }
  }

  return { lines: visible, start, end, maxScroll, total };
}

function wrappedLineCount(text: string, width: number): number {
  if (text.length === 0) return 1;
  return Math.ceil(text.length / width);
}

function wrappedTextAt(text: string, width: number, index: number): string {
  if (text.length === 0) return '';
  const start = index * width;
  return text.slice(start, start + width);
}

export function scrollBy(current: number, delta: number, maxScroll: number): number {
  return Math.min(maxScroll, Math.max(0, current + delta));
}
