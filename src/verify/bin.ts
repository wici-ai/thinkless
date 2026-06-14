import { readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { exists } from '../shared/atomic.js';

async function main(): Promise<void> {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string; bin: { wici: string } };
  const build = await execa('npm', ['run', 'build'], { all: true, reject: false });
  assert(build.exitCode === 0, `build failed before bin verification:\n${build.all}`);
  assert(await exists(pkg.bin.wici), `package bin target does not exist after build: ${pkg.bin.wici}`);

  const version = await execa(process.execPath, [pkg.bin.wici, '--version'], { all: true, reject: false });
  assert(version.exitCode === 0, `built CLI --version failed:\n${version.all}`);
  assert((version.stdout || version.all || '').trim() === pkg.version, `built CLI version mismatch: expected ${pkg.version}, got ${version.stdout || version.all}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        bin: pkg.bin.wici,
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
