import { chmod, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { ensureDir, readJsonFile, readJsonLines } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { Checkpoint, LedgerEntry, RunEvent } from '../shared/types.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/direct-rollback-target');

async function main(): Promise<void> {
  try {
    await createSampleTarget(target, true);
    const paths = runPaths(target);
    await writeFile(
      paths.plan,
      [
        '# PLAN',
        '',
        '- [ ] S1 Establish measured direct baseline',
        '- [ ] S2 Trigger measured direct regression',
        ''
      ].join('\n')
    );
    await ensureDir(paths.opt);
    await writeFile(
      paths.measure,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'count_file=".thinkless/direct-rollback-measure-count"',
        'mkdir -p "$(dirname "$count_file")"',
        'count=0',
        'if [[ -f "$count_file" ]]; then count="$(cat "$count_file")"; fi',
        'count=$((count + 1))',
        'echo "$count" > "$count_file"',
        'if [[ "$count" -eq 1 ]]; then',
        '  echo "METRIC value=100 p50=100 p95=100 p99=100 unit=score n=5"',
        'else',
        '  echo "METRIC value=80 p50=80 p95=80 p99=80 unit=score n=5"',
        'fi',
        ''
      ].join('\n')
    );
    await chmod(paths.measure, 0o755);

    const result = await runSupervisor({
      target,
      goal: 'Run two direct steps and roll back if the measured score regresses.',
      maxIters: 2,
      mode: 'stub'
    });
    assert(result.state === 'STOP' && result.reason === 'Reached max_iters=2', `unexpected run result: ${JSON.stringify(result)}`);

    const ledger = await readJsonLines<LedgerEntry>(paths.ledger);
    assert(ledger.length === 2, `expected two direct ledger rows: ${JSON.stringify(ledger)}`);
    assert(ledger[0].status === 'keep' && ledger[0].metric?.value === 100, `first direct row should keep baseline metric: ${JSON.stringify(ledger[0])}`);
    assert(ledger[1].status === 'revert', `second direct row should revert regression: ${JSON.stringify(ledger[1])}`);
    assert(ledger[1].metric?.value === 80, `regressed row should retain measured metric: ${JSON.stringify(ledger[1])}`);
    assert(ledger[1].baseline?.value === 100, `regressed row should retain previous baseline metric: ${JSON.stringify(ledger[1])}`);
    assert(typeof ledger[1].delta_pct === 'number' && ledger[1].delta_pct < 0, `regressed row should record negative delta: ${JSON.stringify(ledger[1])}`);

    const events = await readJsonLines<RunEvent>(paths.events);
    assert(events.some((event) => event.type === 'DIRECT_METRIC_REGRESSION'), 'missing DIRECT_METRIC_REGRESSION event');

    const checkpoint = await readJsonFile<Checkpoint>(paths.checkpoint);
    assert(checkpoint.best_commit === ledger[0].commit, `regression should not replace best commit: checkpoint=${JSON.stringify(checkpoint)} ledger=${JSON.stringify(ledger)}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          direct_regression_reverted: true,
          baseline: ledger[1].baseline?.value,
          metric: ledger[1].metric?.value,
          delta_pct: ledger[1].delta_pct
        },
        null,
        2
      )
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
