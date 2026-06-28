import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { ensureRunDirs, runPaths } from '../shared/paths.js';
import type { Checkpoint, GoalFile, WiCiConfig } from '../shared/types.js';
import { startExecutorStep, type ExecutorBackendFallback } from '../supervisor/executor.js';
import { directContinuationVerdict } from '../supervisor/stop.js';
import { isTransientNetworkFailure } from '../supervisor/transientRetry.js';

const target = resolve('fixture/app-server-fallback-target');
const fakeBin = resolve('fixture/app-server-fallback-bin');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFakeCodex();

  const originalPath = process.env.PATH ?? '';
  process.env.PATH = `${fakeBin}${delimiter}${originalPath}`;
  try {
    const paths = runPaths(target);
    await ensureRunDirs(paths);
    await writeFile(paths.goalDoc, '# GOAL\n\nRecover when app-server reconnects forever.\n');
    await writeFile(paths.plan, '# Plan\n\n- [ ] S1 Execute through fallback\n');

    const fallbacks: ExecutorBackendFallback[] = [];
    const controller = await startExecutorStep(paths, goal(), 'S1', 1, config(), checkpoint(), undefined, undefined, {
      heartbeatMs: 50,
      idleTimeoutMs: 2_000,
      hardTimeoutMs: 5_000,
      firstMeaningfulEventTimeoutMs: 300,
      onBackendFallback: async (fallback) => {
        fallbacks.push(fallback);
      }
    });
    const result = await controller.done;

    assert(controller.backend === 'app-server', `expected initial app-server controller, got ${controller.backend}`);
    assert(fallbacks.length === 1, `expected one app-server fallback, got ${JSON.stringify(fallbacks)}`);
    assert(fallbacks[0].phase === 'turn', `expected turn fallback after reconnect loop, got ${JSON.stringify(fallbacks[0])}`);
    assert(fallbacks[0].reason.includes('no actionable turn event'), `unexpected fallback reason: ${fallbacks[0].reason}`);
    assert(result.step_done && result.tests_pass, `fallback executor did not complete: ${JSON.stringify(result)}`);
    assert((result.invocation.stdout ?? '').includes('exec fallback completed'), 'codex exec fallback stdout was not returned');

    const transcript = await readFile(paths.codexRun, 'utf8');
    assert(transcript.includes('connection/reconnecting'), 'app-server reconnect notifications were not recorded');
    assert(
      isTransientNetworkFailure('Codex app-server error: Selected model is at capacity. Please try a different model.'),
      'capacity errors must be classified as transient failures'
    );

    const freshFallbacks: ExecutorBackendFallback[] = [];
    const freshController = await startExecutorStep(paths, goal(), 'S1', 2, config(), checkpointWithExecutorApp(), undefined, undefined, {
      resume: false,
      freshFallback: true,
      heartbeatMs: 50,
      idleTimeoutMs: 2_000,
      hardTimeoutMs: 5_000,
      firstMeaningfulEventTimeoutMs: 300,
      artifactId: 'iter-2',
      onBackendFallback: async (fallback) => {
        freshFallbacks.push(fallback);
      }
    });
    const freshResult = await freshController.done;
    assert(freshResult.step_done && freshResult.tests_pass, `fresh fallback executor did not complete: ${JSON.stringify(freshResult)}`);
    assert(freshFallbacks.length === 1, `expected one fresh app-server fallback, got ${JSON.stringify(freshFallbacks)}`);

    const argsLog = (await readFile(join(paths.wici, 'fake-codex-args.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[] });
    const freshExecArgs = argsLog.at(-1)?.args ?? [];
    assert(freshExecArgs[0] === 'exec', `fresh fallback did not call codex exec: ${JSON.stringify(freshExecArgs)}`);
    assert(freshExecArgs[1] !== 'resume', `fresh fallback must not use codex exec resume --last: ${JSON.stringify(freshExecArgs)}`);
    assert(freshExecArgs.includes('-C'), `fresh fallback must set target cwd with -C: ${JSON.stringify(freshExecArgs)}`);

    const originalRetryDelay = process.env.WICI_TRANSIENT_RETRY_DELAY_MS;
    process.env.WICI_TRANSIENT_RETRY_DELAY_MS = '0';
    try {
      await writeFile(paths.assumptions, '# Assumptions\n\n- Capacity retries should not fall through to continuation fallback.\n');
      await writeFile(paths.goalDoc, '# capacity-retry-goal\n\nAll acceptance evidence is present after retry.\n');
      const verdict = await directContinuationVerdict(paths, goal('capacity-retry-goal'), [], config('codex'));
      assert(verdict.decision === 'complete', `expected retried Codex verdict to complete, got ${JSON.stringify(verdict)}`);
      assert(verdict.source === 'llm', `expected retried Codex verdict to be explicit, got ${JSON.stringify(verdict)}`);
    } finally {
      if (originalRetryDelay === undefined) delete process.env.WICI_TRANSIENT_RETRY_DELAY_MS;
      else process.env.WICI_TRANSIENT_RETRY_DELAY_MS = originalRetryDelay;
    }

    console.log(JSON.stringify({ ok: true, app_server_reconnect_fallback: true, fresh_fallback: true, capacity_retry: true, fallback: fallbacks[0] }, null, 2));
  } finally {
    process.env.PATH = originalPath;
    await rm(target, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
}

async function writeFakeCodex(): Promise<void> {
  const path = await fakeCommandPath('codex');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.999.0');
  process.exit(0);
}

if (args[0] === 'app-server') {
  const rl = createInterface({ input: process.stdin });
  let reconnectTimer;
  function send(message) {
    process.stdout.write(JSON.stringify(message) + '\\n');
  }
  rl.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'fake', platformFamily: 'macos', platformOs: 'darwin' } });
    } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: 'thread-reconnect', sessionId: 'session-reconnect', turns: [], status: { type: 'idle' }, preview: '', ephemeral: false, modelProvider: 'openai', createdAt: 0, updatedAt: 0, cwd: process.cwd(), cliVersion: 'fake', source: 'appServer', threadSource: 'user', forkedFromId: null, parentThreadId: null, path: null, gitInfo: null, name: null, agentNickname: null, agentRole: null }, model: 'fake', modelProvider: 'openai', serviceTier: null, cwd: process.cwd(), instructionSources: [], approvalPolicy: 'never', approvalsReviewer: null, sandbox: { type: 'dangerFullAccess' }, reasoningEffort: null } });
    } else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-reconnect', items: [], itemsView: { type: 'all' }, status: 'inProgress', error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null } } });
      reconnectTimer = setInterval(() => send({ method: 'connection/reconnecting', params: { attempt: Date.now() } }), 25);
      reconnectTimer.unref();
    } else if (message.method === 'initialized') {
    } else {
      send({ id: message.id, result: {} });
    }
  });
  setTimeout(() => process.exit(3), 10_000).unref();
  process.on('SIGTERM', () => {
    if (reconnectTimer) clearInterval(reconnectTimer);
    process.exit(0);
  });
  process.on('SIGINT', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
  await new Promise(() => {});
}

if (args[0] === 'exec') {
  const outputIndex = args.indexOf('--output-last-message');
  const outputPath = args[outputIndex + 1];
  if (!outputPath) {
    console.error('missing --output-last-message');
    process.exit(2);
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const stateDir = dirname(dirname(outputPath));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateDir + '/fake-codex-args.jsonl', JSON.stringify({ args }) + '\\n', { flag: 'a' });
  const promptArg = args.at(-1) || '';
  const prompt = promptArg === '-' ? readFileSync(0, 'utf8') : promptArg;
  if (prompt.includes('capacity-retry-goal')) {
    const attemptPath = outputPath + '.attempt';
    const attempt = existsSync(attemptPath) ? Number(readFileSync(attemptPath, 'utf8')) : 0;
    writeFileSync(attemptPath, String(attempt + 1));
    if (attempt === 0) {
      console.error('Codex app-server error: Selected model is at capacity. Please try a different model.');
      process.exit(1);
    }
    writeFileSync(outputPath, '{"decision":"complete","reason":"capacity cleared after retry"}\\n');
    console.log(JSON.stringify({ type: 'agent_message', text: '{"decision":"complete","reason":"capacity cleared after retry"}' }));
    process.exit(0);
  }
  const resultPath = outputPath.replace(/\\.txt$/, '.json');
  writeFileSync(resultPath, JSON.stringify({ step_done: true, tests_pass: true, notes: 'exec fallback completed', changed_files: [], next: null }, null, 2) + '\\n');
  writeFileSync(outputPath, 'exec fallback completed\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'exec-fallback-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'exec fallback completed' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }));
  process.exit(0);
}

console.error('unexpected fake codex args ' + JSON.stringify(args));
process.exit(2);
`
  );
  await chmod(path, 0o755);
}

async function fakeCommandPath(name: string): Promise<string> {
  if (process.platform !== 'win32') return join(fakeBin, name);
  const cmd = join(fakeBin, `${name}.cmd`);
  await writeFile(cmd, `@echo off\r\nnode "%~dp0\\${name}.js" %*\r\n`);
  return join(fakeBin, `${name}.js`);
}

function goal(text = 'Recover when app-server reconnects forever.'): GoalFile {
  return {
    run_id: 'app-server-fallback',
    version: 1,
    requirements: [{ id: 'R1', text, source: 'initial', status: 'active' }],
    acceptance_criteria: [{ id: 'A1', text: 'executor falls back to codex exec', check: 'verify fallback result' }],
    constraints: [],
    metric: { name: 'planner selected validation', direction: 'maximize', target: null, unit: 'score' },
    budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
    stop: { tau: 0.01, K: 3, N: 4, mode: 'auto' }
  };
}

function checkpoint(): Checkpoint {
  return {
    supervisor_state: 'EXECUTE',
    goal_source: 'cli_goal',
    next_step: 'S1',
    iter: 0,
    goal_version: 1,
    plan_hash: null,
    ledger_seq: 0,
    events_seq: 0,
    sessions: {},
    drained_inbox: [],
    updated_at: new Date().toISOString()
  };
}

function checkpointWithExecutorApp(): Checkpoint {
  return {
    ...checkpoint(),
    sessions: {
      executorApp: {
        threadId: 'thread-reconnect',
        workspace: target,
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        phase: 'idle'
      },
      executorReset: {
        reason: 'manual_restart',
        stepId: 'S1',
        at: new Date().toISOString()
      }
    }
  };
}

function config(plannerCommand: 'claude' | 'codex' = 'claude'): WiCiConfig {
  return {
    tools: {
      mode: 'real',
      planner: { command: plannerCommand, effort: plannerCommand === 'codex' ? 'xhigh' : 'default', model: plannerCommand === 'codex' ? 'gpt-5.5' : undefined },
      executor: { command: 'codex', effort: 'medium', backend: 'app-server', dangerouslyBypassApprovalsAndSandbox: true },
      auto_update: false
    },
    budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
    stop: { tau: 0.01, K: 3, N: 4, mode: 'auto' },
    retry: { max_attempts_per_step: 2, reverts_before_reset: 5, stall_replan_after: 3 },
    evaluation: { noise_threshold: 0.01, min_reps: 5, bootstrap_resamples: 1000, checks_timeout_ms: 300000, measure_timeout_ms: 300000 },
    git: { init_if_missing: false, user_name: 'WiCi Bot', user_email: 'wici@example.invalid' },
    safety: { container_hint: 'test', forbidden_actions: [] }
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
