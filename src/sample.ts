import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { exists } from './shared/atomic.js';

export async function createSampleTarget(target: string, force = false): Promise<string> {
  const root = resolve(target);
  if (force) await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'src'), { recursive: true });

  const files = new Map<string, string>([
    [
      'package.json',
      `${JSON.stringify(
        {
          name: 'wici-slow-target',
          version: '0.0.0',
          private: true,
          type: 'module',
          scripts: {
            test: 'node test.mjs',
            measure: 'node measure.mjs'
          }
        },
        null,
        2
      )}\n`
    ],
    [
      'src/hotpath.js',
      `export function uniqueSorted(values) {
  const unique = [];
  for (const value of values) {
    let seen = false;
    for (const candidate of values) {
      if (candidate === value && unique.includes(candidate)) {
        seen = true;
        break;
      }
    }
    if (!seen) unique.push(value);
  }
  return unique.sort((a, b) => a - b);
}
`
    ],
    [
      'test.mjs',
      `import assert from 'node:assert/strict';
import { uniqueSorted } from './src/hotpath.js';

assert.deepEqual(uniqueSorted([3, 1, 2, 3, 2, 4]), [1, 2, 3, 4]);
assert.deepEqual(uniqueSorted([]), []);
assert.deepEqual(uniqueSorted([5, 5, 5]), [5]);
assert.deepEqual(uniqueSorted([-1, 2, -1, 0]), [-1, 0, 2]);
`
    ],
    [
      'measure.mjs',
      `import { performance } from 'node:perf_hooks';
import { uniqueSorted } from './src/hotpath.js';

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function workload(seed) {
  const values = [];
  let value = seed;
  for (let i = 0; i < 8500; i++) {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    values.push(value % 1800);
  }
  return values;
}

for (let i = 0; i < 2; i++) uniqueSorted(workload(i));

const samples = [];
for (let i = 0; i < 7; i++) {
  const data = workload(i + 10);
  const start = performance.now();
  const result = uniqueSorted(data);
  const elapsed = performance.now() - start;
  if (result.length === 0) throw new Error('invalid result');
  samples.push(elapsed);
}

const p50 = percentile(samples, 0.5);
const p95 = percentile(samples, 0.95);
const p99 = percentile(samples, 0.99);
console.log(\`METRIC p50=\${p50.toFixed(3)} p95=\${p95.toFixed(3)} p99=\${p99.toFixed(3)} unit=ms n=\${samples.length} warmup_discarded=2 samples=\${samples.map((item) => item.toFixed(3)).join(',')}\`);
`
    ],
    ['.gitignore', `.wici/\nnode_modules/\n`]
  ]);

  for (const [name, content] of files) {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    if (force || !(await exists(file))) await writeFile(file, content);
  }

  const isRepo = await execa('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { reject: false });
  if (isRepo.exitCode !== 0) {
    await execa('git', ['-C', root, 'init']);
    await execa('git', ['-C', root, 'config', 'user.name', 'WiCi Fixture']);
    await execa('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
    await execa('git', ['-C', root, 'add', '-A']);
    await execa('git', ['-C', root, 'commit', '-m', 'chore: initial slow fixture']);
  }

  return root;
}
