import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSampleTarget } from '../sample.js';
import { exists } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import type { GoalFile, Checkpoint } from '../shared/types.js';
import type { RunState } from '../tui/useRunState.js';
import { shouldAutoStartExistingRun, shouldUseChatAgentForBlankRun } from '../tui/App.js';
import { buildFallbackChatTurn, shouldStartPlannerFromBlankChat } from '../supervisor/chatAgent.js';
import { buildBlankRunPlanningContext } from '../tui/ChatPane.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/tui-chat-intake-target');
const provenanceTarget = resolve('fixture/tui-chat-intake-provenance-target');
const contextTarget = resolve('fixture/tui-chat-intake-context-target');

async function main(): Promise<void> {
  await createSampleTarget(target, true);
  const paths = runPaths(target);

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.tsx', 'tui', '--target', target, '--max-iters', '1', '--mode', 'stub', '--no-fullscreen'],
    {
      cwd: resolve('.'),
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  await delay(900);
  await stopChild(child);

  assert(!(await exists(paths.goal)), 'fresh TUI without chat must not write .wici/goal.json');
  assert(!(await exists(paths.goalDoc)), 'fresh TUI without chat must not write GOAL.md');
  assert(!(await exists(paths.plan)), 'fresh TUI without chat must not write PLAN.md');
  assert(!(await exists(paths.checkpoint)), 'fresh TUI without chat must not write checkpoint.json');
  assert(!(await exists(paths.events)), 'fresh TUI without chat must not write events.jsonl');

  const ui = stripAnsi(output);
  assert(!ui.includes('waiting for events'), `empty ExecPane should not render fake waiting text:\n${ui}`);
  assert(!ui.includes('Reduce p99 latency while preserving correctness'), 'TUI must not seed the old default goal before chat input');

  const blank = blankState(target);
  assert(
    shouldUseChatAgentForBlankRun({ supervisorEnabled: true, supervisorStarted: false, state: blank }),
    'fresh supervisor-enabled TUI should route blank-run input through the Chat agent'
  );
  assert(
    !shouldUseChatAgentForBlankRun({ supervisorEnabled: true, supervisorStarted: true, state: blank }),
    'started supervisor must route chat through existing-run hot reload, not blank-run planning'
  );
  assert(
    !shouldUseChatAgentForBlankRun({ supervisorEnabled: false, supervisorStarted: false, state: blank }),
    'read-only TUI must not launch planning from chat'
  );
  assert(
    !shouldUseChatAgentForBlankRun({ supervisorEnabled: true, supervisorStarted: false, state: { ...blank, goalDoc: '# GOAL\n' } }),
    'existing run blackboard must not use blank-run chat planning'
  );
  assert(
    shouldUseChatAgentForBlankRun({
      supervisorEnabled: true,
      supervisorStarted: false,
      state: {
        ...blank,
        baseline: {
          best_commit: '0000000000000000000000000000000000000000',
          best_metric: { p50: 1, p95: 1, p99: 1, unit: 'legacy', n: 1 },
          eval_sha256: { measure: 'legacy', checks: 'legacy' },
          plan_hash: 'legacy',
          created_at: '2026-06-14T00:00:00.000Z',
          updated_at: '2026-06-14T00:00:00.000Z'
        }
      }
    }),
    'a historical baseline.json alone must not block fresh Chat-agent intake'
  );
  assert(shouldAutoStartExistingRun({ ...blank, goal: goal() }), 'existing goal without a STOP checkpoint should auto-start');
  assert(!shouldAutoStartExistingRun({ ...blank, goal: goal(), checkpoint: checkpoint('STOP') }), 'stopped run should not auto-restart without new chat');
  assert(!shouldAutoStartExistingRun({ ...blank, goal: goal(), checkpoint: checkpoint('FAILED') }), 'failed run should not auto-restart without new chat');
  assert(shouldAutoStartExistingRun({ ...blank, goal: goal(), checkpoint: checkpoint('PLAN') }), 'active plan state should auto-start on TUI attach');
  verifyDegradedBlankRunChatDecision();
  verifyBlankRunPlanningContext();
  await verifyGoalSourceNotRetroactive();
  await verifyPlannerReceivesChatContext();

  console.log(
    JSON.stringify(
      {
        ok: true,
        target,
        fresh_tui_writes_no_goal_files: true,
        blank_chat_routes_through_agent: true,
        degraded_inspection_does_not_start_planner: true,
        degraded_plan_request_starts_planner: true,
        introduction_does_not_start_planner: true,
        planner_receives_chat_context: true,
        historical_baseline_does_not_block_chat: true,
        goal_source_not_retroactive: true
      },
      null,
      2
    )
  );
}

function verifyDegradedBlankRunChatDecision(): void {
  const inspection = buildFallbackChatTurn(
    {
      paths: {} as never,
      userText: '请先阅读当前代码库和文档，暂时不要开始计划。',
      goalDoc: '',
      plan: '',
      recentEvents: []
    },
    'stub'
  );
  assert(!inspection.update, `degraded blank-run code reading should stay conversational: ${JSON.stringify(inspection)}`);

  const planning = buildFallbackChatTurn(
    {
      paths: {} as never,
      userText: '请制定计划并修复 uniqueSorted 的性能问题。',
      goalDoc: '',
      plan: '',
      recentEvents: []
    },
    'stub'
  );
  assert(planning.update?.kind === 'add_requirement', `degraded concrete planning request should start planner: ${JSON.stringify(planning)}`);

  const intro = buildFallbackChatTurn(
    {
      paths: {} as never,
      userText: '介绍一下你自己',
      goalDoc: '',
      plan: '',
      recentEvents: []
    },
    'stub'
  );
  assert(!intro.update, `self-introduction should stay conversational: ${JSON.stringify(intro)}`);
  assert(
    !shouldStartPlannerFromBlankChat('介绍一下你自己', { kind: 'add_requirement', text: '介绍一下你自己' }),
    'blank-run degraded guard must reject non-actionable fallback updates'
  );
  assert(
    shouldStartPlannerFromBlankChat('可以，开始修复这个问题', { kind: 'add_requirement', text: 'Fix the discussed issue.' }),
    'blank-run planner guard must allow explicit start/fix requests'
  );
}

function verifyBlankRunPlanningContext(): void {
  const context = buildBlankRunPlanningContext(
    [
      { ts: '2026-06-17T10:00:00.000Z', role: 'user', text: '先阅读代码，别开始 planner。' },
      { ts: '2026-06-17T10:00:01.000Z', role: 'assistant', text: '我看到 TUI 里有 chat/runtime/supervisor 三段链路。' }
    ],
    '按刚才讨论的去修复',
    {
      reply: '我会启动 planner，并带上前面的上下文。',
      update: { kind: 'add_requirement', text: 'Fix the chat-to-planner context handoff.' },
      degraded: false
    }
  );
  assert(context.includes('USER: 先阅读代码'), `planning context should include previous user turns:\n${context}`);
  assert(context.includes('ASSISTANT: 我看到 TUI'), `planning context should include previous assistant turns:\n${context}`);
  assert(context.includes('USER: 按刚才讨论的去修复'), `planning context should include the triggering user turn:\n${context}`);
  assert(context.includes('ASSISTANT UPDATE (add_requirement): Fix the chat-to-planner context handoff.'), `planning context should include the emitted update:\n${context}`);
}

async function verifyGoalSourceNotRetroactive(): Promise<void> {
  await createSampleTarget(provenanceTarget, true);
  const first = await runSupervisor({
    target: provenanceTarget,
    goal: 'Original goal created from the first Chat message.',
    goalSource: 'tui_chat',
    maxIters: 0,
    mode: 'stub'
  });
  assert(first.state === 'STOP', `initial provenance run should stop cleanly: ${JSON.stringify(first)}`);
  const paths = runPaths(provenanceTarget);
  const checkpointPath = paths.checkpoint;
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as Checkpoint;
  assert(checkpoint.goal_source === 'tui_chat', `initial goal source should be tui_chat, got ${checkpoint.goal_source}`);
  delete checkpoint.goal_source;
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

  const second = await runSupervisor({
    target: provenanceTarget,
    goal: 'This later CLI goal must not rewrite provenance for the existing run.',
    goalSource: 'cli_goal',
    maxIters: 0,
    mode: 'stub'
  });
  assert(second.state === 'STOP', `retroactive provenance run should stop cleanly: ${JSON.stringify(second)}`);
  const after = JSON.parse(await readFile(checkpointPath, 'utf8')) as Checkpoint;
  assert(after.goal_source === undefined, `existing run goal_source should not be written retroactively, got ${after.goal_source}`);
}

async function verifyPlannerReceivesChatContext(): Promise<void> {
  await createSampleTarget(contextTarget, true);
  const result = await runSupervisor({
    target: contextTarget,
    goal: 'Fix the selected TUI chat intake behavior.',
    goalSource: 'tui_chat',
    planningContext: ['USER: 先阅读代码并解释 TUI 结构。', 'ASSISTANT: Chat input is bottom-mounted and runtime changes are TUI state.', 'USER: 现在按这个上下文开始修。'].join('\n'),
    maxIters: 0,
    mode: 'stub'
  });
  assert(result.state === 'STOP', `context handoff run should stop cleanly: ${JSON.stringify(result)}`);
  const paths = runPaths(contextTarget);
  const goalFile = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  assert(goalFile.requirements[0]?.text === 'Fix the selected TUI chat intake behavior.', `planning context must not rewrite the requirement: ${JSON.stringify(goalFile.requirements)}`);
  assert(goalFile.constraints.some((constraint) => constraint.includes('Chat context before planning') && constraint.includes('runtime changes are TUI state')), `goal.json missing chat context constraint: ${JSON.stringify(goalFile.constraints)}`);
  const goalDoc = await readFile(paths.goalDoc, 'utf8');
  assert(goalDoc.includes('Chat context before planning:'), `GOAL.md missing chat context heading:\n${goalDoc}`);
  assert(goalDoc.includes('  USER: 先阅读代码并解释 TUI 结构。'), `GOAL.md should render multiline chat context as an indented constraint:\n${goalDoc}`);
  assert(goalDoc.includes('  ASSISTANT: Chat input is bottom-mounted'), `GOAL.md missing assistant context:\n${goalDoc}`);
}

function blankState(root: string): RunState {
  return {
    target: root,
    goal: null,
    checkpoint: null,
    baseline: null,
    ledger: [],
    goalDoc: '',
    plan: '',
    events: [],
    codexTranscript: [],
    outbox: [],
    injections: [],
    chat: []
  };
}

function goal(): GoalFile {
  return {
    run_id: 'tui-chat-intake',
    version: 1,
    requirements: [{ id: 'R1', text: 'test', source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'planner-selected validation', direction: 'maximize', target: null, unit: 'score' },
    budget: { max_iters: 1, max_cost_usd: 0, deadline: null },
    stop: { tau: 0.01, K: 1, N: 1, mode: 'auto' }
  };
}

function checkpoint(supervisor_state: Checkpoint['supervisor_state']): Checkpoint {
  return {
    supervisor_state,
    next_step: null,
    iter: 0,
    goal_version: 1,
    plan_hash: null,
    ledger_seq: 0,
    events_seq: 0,
    sessions: {},
    drained_inbox: [],
    updated_at: '2026-06-14T00:00:00.000Z'
  };
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    delay(1000).then(() => false)
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[=>]/g, '');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
