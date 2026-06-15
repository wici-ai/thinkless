import { chmod, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { atomicWriteFile } from '../shared/atomic.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { GoalFile, WiCiConfig } from '../shared/types.js';
import { runExecutorStep, type ExecutorProgress } from '../supervisor/executor.js';

const target = resolve('fixture/executor-contract-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);
  await ensureRunDirs(paths);
  await atomicWriteFile(
    paths.plan,
    `# Contract Plan

- [ ] S1 Exercise first codex exec invocation
- [ ] S2 Exercise codex exec resume invocation
`
  );

  const fakeCodex = join(paths.wici, 'fake-codex.mjs');
  await atomicWriteFile(fakeCodex, fakeCodexScript(), 0o755);
  await chmod(fakeCodex, 0o755);

  const config = testConfig(fakeCodex);
  const progress: ExecutorProgress[] = [];
  const first = await runExecutorStep(paths, goal(), 'S1', 1, config, undefined, 'remember prior accepted patch', {
    onProgress: async (item) => {
      progress.push(item);
    }
  });
  const second = await runExecutorStep(paths, goal(), 'S2', 2, config, 'new operator steering', 'remember prior accepted patch', {
    onProgress: async (item) => {
      progress.push(item);
    }
  });

  assert(first.notes === 'fake codex iter 1', `unexpected first iter notes: ${first.notes}`);
  assert(second.notes === 'fake codex iter 2', `unexpected second iter notes: ${second.notes}`);
  assert(first.invocation.usage?.completed_turns === 1, `first invocation missing completed turn usage: ${JSON.stringify(first.invocation.usage)}`);
  assert(second.invocation.usage?.tokens_input === 102, `second invocation missing parsed token usage: ${JSON.stringify(second.invocation.usage)}`);
  assert(progress.some((item) => item.kind === 'event' && item.eventType === 'turn.completed'), 'executor progress did not surface turn.completed');
  assert(progress.some((item) => item.usage.tokens_input === 102), 'executor progress did not carry token usage');

  const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string; iter: number });
  assert(argsLog.length === 2, `expected two fake codex invocations, got ${argsLog.length}`);
  assert(argsLog[0].args[0] === 'exec' && argsLog[0].args[1] !== 'resume', `first invocation was not codex exec: ${JSON.stringify(argsLog[0].args)}`);
  assert(argsLog[1].args[0] === 'exec' && argsLog[1].args[1] === 'resume', `second invocation was not codex exec resume: ${JSON.stringify(argsLog[1].args)}`);
  assert(argsLog[0].args.includes('-C'), `first codex exec should set target cwd with -C: ${JSON.stringify(argsLog[0].args)}`);
  assert(!argsLog[1].args.includes('-C'), `codex exec resume does not support -C and must rely on spawn cwd: ${JSON.stringify(argsLog[1].args)}`);
  for (const item of argsLog) {
    assert(item.args.includes('--dangerously-bypass-approvals-and-sandbox'), `executor missing autonomy flag: ${JSON.stringify(item.args)}`);
    assert(item.args.includes('--json'), `executor missing json flag: ${JSON.stringify(item.args)}`);
    assert(item.args.includes('--output-schema'), `executor missing output schema flag: ${JSON.stringify(item.args)}`);
    assert(item.args.includes('--output-last-message'), `executor missing output-last-message flag: ${JSON.stringify(item.args)}`);
    assert(item.args.includes('--skip-git-repo-check'), `executor missing git repo skip flag: ${JSON.stringify(item.args)}`);
  }

  const secondPrompt = await readFile(join(paths.artifacts, 'iter-2.prompt.txt'), 'utf8');
  assert(secondPrompt.includes('Continue the existing Codex session for this WiCi run.'), 'resume prompt must continue the existing Codex session');
  assert(secondPrompt.includes('Supervisor receipt focus: S2.'), 'resume prompt missing supervisor receipt focus');
  assert(secondPrompt.includes('GOAL.md and PLAN.md have already been updated on disk'), 'resume prompt must tell Codex to re-read updated disk files');
  assert(secondPrompt.includes('New requirement or steering delta to apply now:\nnew operator steering'), 'resume prompt missing steering delta');
  assert(!secondPrompt.includes('Current PLAN.md:'), 'resume prompt should not inline the full PLAN.md');
  assert(secondPrompt.length < 4_000, `resume prompt should stay compact, got ${secondPrompt.length} chars`);
  assert(secondPrompt.includes('remember prior accepted patch'), 'resume prompt missing retrieved memory');

  const secondLastMessage = await readFile(join(paths.artifacts, 'iter-2.txt'), 'utf8');
  assert(secondLastMessage.includes('fake codex iter 2'), 'fake codex did not honor --output-last-message path');

  const transcript = await readFile(paths.codexRun, 'utf8');
  assert(transcript.includes('"turn.completed"'), 'codex transcript missing turn.completed event');
  assert(transcript.includes('"item.completed"'), 'codex transcript missing item.completed event');

  await verifyIdleWatchdog(paths);
  await verifyFirstMeaningfulEventWatchdog(paths);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        fake_codex_invocations: argsLog.length,
        resume_used: true,
        artifact_contract: true,
        usage_parsed: true,
        streaming_progress: true,
        idle_watchdog: true
      },
      null,
      2
    )
  );
}

async function verifyFirstMeaningfulEventWatchdog(paths: ReturnType<typeof runPaths>): Promise<void> {
  const threadOnlyCodex = join(paths.wici, 'fake-thread-only-codex.mjs');
  await atomicWriteFile(threadOnlyCodex, threadOnlyCodexScript(), 0o755);
  await chmod(threadOnlyCodex, 0o755);

  let error: unknown;
  try {
    await runExecutorStep(
      paths,
      goal(),
      'S1',
      1,
      {
        ...testConfig(threadOnlyCodex),
        tools: {
          ...testConfig(threadOnlyCodex).tools,
          mode: 'real'
        }
      },
      undefined,
      undefined,
      {
      artifactId: 'thread-only-1',
      firstMeaningfulEventTimeoutMs: 500,
      idleTimeoutMs: 2_000,
      hardTimeoutMs: 5_000,
      heartbeatMs: 25
      }
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof Error, 'thread-only fake codex should fail before the long idle timeout');
  assert(error.message.includes('no actionable event'), `unexpected thread-only fake codex error: ${error.message}`);
}

async function verifyIdleWatchdog(paths: ReturnType<typeof runPaths>): Promise<void> {
  const hangingCodex = join(paths.wici, 'fake-hanging-codex.mjs');
  await atomicWriteFile(hangingCodex, hangingCodexScript(), 0o755);
  await chmod(hangingCodex, 0o755);

  const heartbeatProgress: ExecutorProgress[] = [];
  let error: unknown;
  try {
    await runExecutorStep(
      paths,
      goal(),
      'S1',
      1,
      {
        ...testConfig(hangingCodex),
        tools: {
          ...testConfig(hangingCodex).tools,
          mode: 'real'
        }
      },
      undefined,
      undefined,
      {
        artifactId: 'hang-1',
        idleTimeoutMs: 100,
        hardTimeoutMs: 2_000,
        heartbeatMs: 25,
        onProgress: async (item) => {
          heartbeatProgress.push(item);
        }
      }
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof Error, 'hanging fake codex should fail by idle timeout');
  assert(error.message.includes('Codex executor timed out'), `unexpected hanging fake codex error: ${error.message}`);
  assert(heartbeatProgress.some((item) => item.kind === 'heartbeat'), 'executor idle watchdog did not emit heartbeat progress');
}

function goal(): GoalFile {
  return {
    run_id: 'executor-contract',
    version: 1,
    requirements: [{ id: 'R1', text: 'Verify executor contract without invoking real Codex', source: 'initial', status: 'active' }],
    acceptance_criteria: [{ id: 'A1', text: 'executor contract verifier passes', check: 'npm run verify:executor-contract' }],
    constraints: [],
    metric: { name: 'fixture runtime', direction: 'minimize', target: null, unit: 'ms' },
    budget: { max_iters: 2, max_cost_usd: 1, deadline: null },
    stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' }
  };
}

function testConfig(fakeCodex: string): WiCiConfig {
  return {
    tools: {
      mode: 'auto',
      planner: { command: 'claude', effort: 'default' },
      executor: { command: fakeCodex, dangerouslyBypassApprovalsAndSandbox: true }
    },
    budget: { max_iters: 2, max_cost_usd: 1, deadline: null },
    stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' },
    retry: { max_attempts_per_step: 1, reverts_before_reset: 1, stall_replan_after: 1 },
    evaluation: { noise_threshold: 0.01, min_reps: 5, bootstrap_resamples: 1000, checks_timeout_ms: 300000, measure_timeout_ms: 300000 },
    git: { init_if_missing: false, user_name: 'WiCi Bot', user_email: 'wici@example.invalid' },
    safety: { container_hint: 'executor contract fixture', forbidden_actions: ['git push', 'rm -rf outside workspace'] }
  };
}

function fakeCodexScript(): string {
  return `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? '';
const match = prompt.match(/iter-(\\d+)\\.json/);
const iter = Number(match?.[1] ?? 0);
if (!iter) {
  console.error('fake codex could not find iter-N.json in prompt');
  process.exit(2);
}

const cwd = process.cwd();
const artifacts = join(cwd, '.wici', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const result = {
  step_done: iter > 1,
  tests_pass: true,
  notes: \`fake codex iter \${iter}\`,
  changed_files: [],
  next: iter === 1 ? 'S2' : null
};
writeFileSync(join(artifacts, \`iter-\${iter}.json\`), JSON.stringify(result, null, 2) + '\\n');

const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0 && args[outputIndex + 1]) {
  writeFileSync(resolve(cwd, args[outputIndex + 1]), result.notes + '\\n');
}
appendFileSync(join(cwd, '.wici', 'fake-codex-args.jsonl'), JSON.stringify({ args, prompt, iter, cwd }) + '\\n');
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100 + iter, output_tokens: 10 + iter, cost_usd: Number((0.001 * iter).toFixed(3)) } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'message', iter } }));
`;
}

function hangingCodexScript(): string {
  return `#!/usr/bin/env node
setInterval(() => {}, 1000);
`;
}

function threadOnlyCodexScript(): string {
  return `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }));
setInterval(() => {}, 1000);
`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
