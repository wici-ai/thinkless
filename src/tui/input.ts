export const ENABLE_MOUSE_REPORTING_SEQUENCE = '\x1b[?1000h\x1b[?1006h';
export const DISABLE_MOUSE_REPORTING_SEQUENCE = '\x1b[?1007l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';

export function enableMouseReporting(stdout: NodeJS.WriteStream): () => void {
  stdout.write(ENABLE_MOUSE_REPORTING_SEQUENCE);
  installMouseCleanup(stdout);
  return () => disableMouseReporting(stdout);
}

export function disableMouseReporting(stdout: NodeJS.WriteStream = process.stdout): void {
  try {
    stdout.write(DISABLE_MOUSE_REPORTING_SEQUENCE);
  } catch {
    // Best-effort terminal cleanup only.
  }
}

let cleanupInstalled = false;

function installMouseCleanup(stdout: NodeJS.WriteStream): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.once('exit', () => disableMouseReporting(stdout));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      disableMouseReporting(stdout);
      process.exit(exitCodeForSignal(signal));
    });
  }
}

function exitCodeForSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 129;
}

export function mouseScrollDelta(input: string): number {
  let delta = 0;
  for (const event of parseMouseInputs(input)) {
    const code = event.code;
    if (code < 64) continue;
    const wheelButton = code & 3;
    if (wheelButton === 0) delta += 1;
    else if (wheelButton === 1) delta -= 1;
  }
  return delta;
}

export function isMouseInput(input: string): boolean {
  return parseMouseInputs(input).length > 0;
}

export interface MouseEventInput {
  code: number;
  x: number;
  y: number;
  released: boolean;
}

export function parseMouseInput(input: string): MouseEventInput | null {
  return parseMouseInputs(input)[0] ?? null;
}

function parseMouseInputs(input: string): MouseEventInput[] {
  return [...parseSgrMouseInputs(input), ...parseUrxvtMouseInputs(input), ...parseX10MouseInputs(input)];
}

function parseSgrMouseInputs(input: string): MouseEventInput[] {
  const events: MouseEventInput[] = [];
  const matches = input.matchAll(/(?:\x1b)?\[<(\d+);(\d+);(\d+)([mM])/g);
  for (const match of matches) {
    events.push({
      code: Number(match[1]),
      x: Number(match[2]),
      y: Number(match[3]),
      released: match[4] === 'm'
    });
  }
  return events;
}

function parseUrxvtMouseInputs(input: string): MouseEventInput[] {
  const events: MouseEventInput[] = [];
  const matches = input.matchAll(/(?:\x1b)?\[(?!<)(\d+);(\d+);(\d+)M/g);
  for (const match of matches) {
    const code = Number(match[1]);
    events.push({
      code,
      x: Number(match[2]),
      y: Number(match[3]),
      released: (code & 3) === 3
    });
  }
  return events;
}

function parseX10MouseInputs(input: string): MouseEventInput[] {
  return [...parseX10MouseInputsWithMarker(input, '\x1b[M'), ...parseX10MouseInputsWithMarker(input, '[M')];
}

function parseX10MouseInputsWithMarker(input: string, marker: string): MouseEventInput[] {
  const events: MouseEventInput[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf(marker, cursor);
    if (start < 0) break;
    if (marker === '[M' && start > 0 && input[start - 1] === '\x1b') {
      cursor = start + marker.length;
      continue;
    }
    const dataStart = start + marker.length;
    if (dataStart + 2 >= input.length) break;
    const code = input.charCodeAt(dataStart) - 32;
    const x = input.charCodeAt(dataStart + 1) - 32;
    const y = input.charCodeAt(dataStart + 2) - 32;
    events.push({
      code,
      x,
      y,
      released: (code & 3) === 3
    });
    cursor = dataStart + 3;
  }
  return events;
}
