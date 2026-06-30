import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWriteJson } from '../shared/atomic.js';
import { loadConfig } from '../shared/config.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { GoalFile, WiCiConfig } from '../shared/types.js';
import { runPlanDiff } from '../supervisor/planner.js';

async function main(): Promise<void> {
  const target = resolve('fixture/planner-context-reset-target');
  const fakeBin = resolve('fixture/planner-context-reset-bin');
  await rm(target, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await mkdir(fakeBin, { recursive: true });

  const fakeCodex = join(fakeBin, 'codex');
  await writeFakeCodex(fakeCodex, target);

  const paths = runPaths(target);
  await ensureRunDirs(paths);
  const config = (await loadConfig('auto')) as WiCiConfig;
  config.tools.planner.command = fakeCodex;
  const goal: GoalFile = {
    run_id: 'planner-context-reset',
    version: 1,
    requirements: [{ id: 'R1', text: 'Recover planner diff when the resume thread is full.', source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'planner context reset', direction: 'maximize', target: null, unit: 'ok' },
    budget: config.budget,
    stop: config.stop
  };
  await atomicWriteJson(paths.goal, goal);
  await writeFile(paths.goalDoc, '# GOAL\n\nRecover planner diff when the resume thread is full.\n');
  await writeFile(paths.plan, '# Plan\n\n- [x] S1 Existing completed step\n');

  const result = await runPlanDiff(paths, goal, 'full-planner-session', 'Add the next concrete step.', config);
  assert(result.ok, `planner diff should recover on a fresh Codex thread: ${JSON.stringify(result)}`);
  assert(result.sessionId === 'fresh-planner-session', `fresh planner session should be recorded, got ${result.sessionId}`);

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-planner-context-args.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  assert(argsLog.length === 2, `expected resume attempt plus fresh retry: ${JSON.stringify(argsLog)}`);
  assert(argsLog[0]?.args[0] === 'exec' && argsLog[0]?.args[1] === 'resume', `first planner diff should resume old session: ${JSON.stringify(argsLog[0])}`);
  assert(argsLog[0]?.args.includes('full-planner-session'), `first planner diff should target full session: ${JSON.stringify(argsLog[0])}`);
  assert(argsLog[1]?.args[0] === 'exec' && argsLog[1]?.args[1] !== 'resume', `fresh retry must not resume old session: ${JSON.stringify(argsLog[1])}`);

  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('Recovered after planner context reset'), `fresh planner diff did not materialize PLAN.md:\n${plan}`);

  console.log(JSON.stringify({ ok: true, planner_context_reset: true, attempts: argsLog.length }, null, 2));
}

async function writeFakeCodex(path: string, target: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const stateDir = path.join(${JSON.stringify(target)}, '.thinkless');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'fake-codex-planner-context-args.jsonl'), JSON.stringify({ args, prompt }) + '\\n');
  if (args[0] === 'exec' && args[1] === 'resume') {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'full-planner-session' }));
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(JSON.stringify({ type: 'error', message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying." }));
    console.log(JSON.stringify({ type: 'turn.failed', error: { message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying." } }));
    process.exit(1);
  }
  const outputIdx = args.indexOf('--output-last-message');
  if (outputIdx >= 0) {
    fs.writeFileSync(args[outputIdx + 1], [
      '## PLAN.md',
      '',
      '# Plan',
      '',
      '- [ ] S2 Recovered after planner context reset'
    ].join('\\n'));
  }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fresh-planner-session' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fresh planner diff complete' } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`
  );
  await chmod(path, 0o755);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
