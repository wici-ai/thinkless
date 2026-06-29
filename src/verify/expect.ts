import { execa } from 'execa';

export async function requireExpectOrSkip(verifier: string): Promise<void> {
  const found = await execa('command', ['-v', 'expect'], { shell: true, reject: false });
  if (found.exitCode === 0) return;
  if (process.platform === 'win32') {
    console.log(JSON.stringify({ ok: true, skipped: true, verifier, reason: 'expect not available on PATH on Windows' }, null, 2));
    process.exit(0);
  }
  throw new Error(`${verifier} requires expect on PATH`);
}
