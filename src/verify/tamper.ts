import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { BaselineFile } from '../shared/types.js';

process.env.WICI_LEGACY_OPTIMIZER = '1';

async function main(): Promise<void> {
  const measure = await runTamperScenario(resolve('fixture/tamper-target'), async (paths) => {
    await chmod(paths.measure, 0o755);
    await appendFile(paths.measure, '\n# tampered after lock\n');
  });
  const guard = await runTamperScenario(resolve('fixture/tamper-guard-target'), async (paths) => {
    const testFile = join(paths.target, 'test.mjs');
    await chmod(testFile, 0o755);
    await appendFile(testFile, '\n// tampered after lock\n');
  });
  const validate = await runTamperScenario(
    resolve('fixture/tamper-validate-target'),
    async (paths) => {
      await chmod(paths.validate, 0o755);
      await appendFile(paths.validate, '\n# tampered hidden validation after lock\n');
    },
    async (paths) => {
      await mkdir(dirname(paths.validate), { recursive: true });
      await writeFile(
        paths.validate,
        `#!/usr/bin/env bash
set -euo pipefail
node measure.mjs
`
      );
      await chmod(paths.validate, 0o755);
    }
  );
  const prescreen = await runTamperScenario(
    resolve('fixture/tamper-prescreen-target'),
    async (paths) => {
      await chmod(paths.prescreen, 0o755);
      await appendFile(paths.prescreen, '\n# tampered cascade pre-screen after lock\n');
    },
    async (paths) => {
      await mkdir(dirname(paths.prescreen), { recursive: true });
      await writeFile(
        paths.prescreen,
        `#!/usr/bin/env bash
set -euo pipefail
node measure.mjs
`
      );
      await chmod(paths.prescreen, 0o755);
    }
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        rejected_measure_tamper: true,
        rejected_guard_tamper: true,
        rejected_validate_tamper: true,
        rejected_prescreen_tamper: true,
        measure_hash_pinned: measure.eval_sha256.measure,
        prescreen_hash_pinned: prescreen.eval_sha256.prescreen,
        validate_hash_pinned: validate.eval_sha256.validate,
        guard_files_pinned: Object.keys(guard.eval_sha256.files ?? {})
      },
      null,
      2
    )
  );
}

async function runTamperScenario(
  target: string,
  tamper: (paths: ReturnType<typeof runPaths>) => Promise<void>,
  setup?: (paths: ReturnType<typeof runPaths>) => Promise<void>
): Promise<BaselineFile> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await setup?.(paths);

  const init = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Initialize locked eval scripts', '--max-iters', '0', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(init.exitCode === 0, `initial baseline run failed:\n${init.all}`);

  const before = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(Object.keys(before.eval_sha256.files ?? {}).includes('test.mjs'), `baseline did not pin test.mjs: ${JSON.stringify(before.eval_sha256)}`);
  await tamper(paths);

  const tampered = await execa(process.execPath, ['--import', 'tsx', 'src/cli.tsx', 'run', '--target', target, '--goal', 'Should reject tampered eval', '--max-iters', '1', '--mode', 'stub'], {
    cwd: resolve('.'),
    all: true,
    reject: false,
    timeout: 30_000
  });
  assert(tampered.exitCode !== 0, `tampered eval unexpectedly succeeded:\n${tampered.all}`);
  assert((tampered.all ?? '').includes('eval_sha256 mismatch') || (await readFile(paths.events, 'utf8')).includes('eval_sha256 mismatch'), 'missing eval_sha256 mismatch evidence');

  const after = JSON.parse(await readFile(paths.baseline, 'utf8')) as BaselineFile;
  assert(after.eval_sha256.measure === before.eval_sha256.measure, 'baseline measure hash changed after tamper');
  assert(after.eval_sha256.checks === before.eval_sha256.checks, 'baseline checks hash changed after tamper');
  assert(after.eval_sha256.prescreen === before.eval_sha256.prescreen, 'baseline prescreen hash changed after tamper');
  assert(after.eval_sha256.validate === before.eval_sha256.validate, 'baseline validate hash changed after tamper');
  assert(JSON.stringify(after.eval_sha256.files ?? {}) === JSON.stringify(before.eval_sha256.files ?? {}), 'baseline guard file hashes changed after tamper');
  return before;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
