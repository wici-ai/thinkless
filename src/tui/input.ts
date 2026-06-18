export function enableMouseReporting(stdout: NodeJS.WriteStream): () => void {
  stdout.write('\x1b[?1000h\x1b[?1006h\x1b[?1007h');
  installMouseCleanup(stdout);
  return () => disableMouseReporting(stdout);
}

export function disableMouseReporting(stdout: NodeJS.WriteStream = process.stdout): void {
  try {
    stdout.write('\x1b[?1007l\x1b[?1006l\x1b[?1002l\x1b[?1000l');
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
  const matches = input.matchAll(/(?:\x1b)?\[<(\d+);\d+;\d+[mM]/g);
  for (const match of matches) {
    const code = Number(match[1]);
    if (code < 64) continue;
    const wheelButton = code & 3;
    if (wheelButton === 0) delta += 1;
    else if (wheelButton === 1) delta -= 1;
  }
  return delta;
}

export function isMouseInput(input: string): boolean {
  return /(?:\x1b)?\[<\d+;\d+;\d+[mM]/.test(input);
}

export interface MouseEventInput {
  code: number;
  x: number;
  y: number;
  released: boolean;
}

export function parseMouseInput(input: string): MouseEventInput | null {
  const match = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([mM])/.exec(input);
  if (!match) return null;
  return {
    code: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    released: match[4] === 'm'
  };
}
