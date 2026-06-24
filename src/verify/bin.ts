import { readFile, stat } from 'node:fs/promises';
import { execa } from 'execa';
import { exists } from '../shared/atomic.js';

async function main(): Promise<void> {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string; bin: Record<string, string> };
  const build = await execa('npm', ['run', 'build'], { all: true, reject: false });
  assert(build.exitCode === 0, `build failed before bin verification:\n${build.all}`);
  assert(Object.keys(pkg.bin).length === 1 && Boolean(pkg.bin.thinkless), `package must expose only the thinkless binary: ${JSON.stringify(pkg.bin)}`);

  for (const [name, bin] of Object.entries(pkg.bin)) {
    assert(await exists(bin), `package bin target does not exist after build: ${bin}`);
    const info = await stat(bin);
    assert((info.mode & 0o111) !== 0, `${name} built CLI is not executable: ${bin}`);
    const version = await execa(bin, ['--version'], { all: true, reject: false });
    assert(version.exitCode === 0, `${name} built CLI --version failed:\n${version.all}`);
    assert((version.stdout || version.all || '').trim() === pkg.version, `${name} built CLI version mismatch: expected ${pkg.version}, got ${version.stdout || version.all}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        bins: pkg.bin,
        version: pkg.version,
        built_cli_version_matches_package: true
      },
      null,
      2
    )
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
