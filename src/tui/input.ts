export function enableMouseReporting(stdout: NodeJS.WriteStream): () => void {
  stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  return () => {
    stdout.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
  };
}

export function mouseScrollDelta(input: string): number {
  const match = /\x1b\[<(\d+);\d+;\d+M/.exec(input);
  if (!match) return 0;
  const code = Number(match[1]);
  if (code === 64) return 1;
  if (code === 65) return -1;
  return 0;
}
