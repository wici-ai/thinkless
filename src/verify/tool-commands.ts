import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { buildExecutorArgs } from '../supervisor/executor.js';
import { buildChatArgs, buildCodexChatArgs, extractCodexSessionId, runChatTurn } from '../supervisor/chatAgent.js';
import {
  buildInitialPlannerArgs,
  buildInitialPlannerResumeArgs,
  buildPlanDiffArgs,
  extractPlannerResponse,
  extractStructured,
  plannerProgressFromLine,
  runInitialPlanner,
  runPlanDiff
} from '../supervisor/planner.js';
import { ensureRunDirs, promptPath, runPaths, schemaPath } from '../shared/paths.js';
import { parsePlanSteps } from '../supervisor/plan.js';
import { atomicWriteJson, exists } from '../shared/atomic.js';
import { applyRuntimeSelection, loadConfig } from '../shared/config.js';
import type { GoalFile, WiCiConfig } from '../shared/types.js';
import { resolveMaxIters } from '../supervisor/index.js';

async function main(): Promise<void> {
  const iterSchema = JSON.parse(await readFile(schemaPath('iter-result'), 'utf8')) as { additionalProperties?: unknown };
  const plannerArgs = buildInitialPlannerArgs({
    goalText: 'test',
    effort: 'default',
    systemPrompt: 'planner prompt'
  });
  const customPlannerArgs = buildInitialPlannerArgs({
    goalText: 'test',
    effort: 'high',
    model: 'claude-sonnet-test',
    systemPrompt: 'planner prompt'
  });
  const diffArgs = buildPlanDiffArgs({
    newText: 'new requirement',
    currentPlan: '# plan',
    goalText: '# GOAL\n\n## Requirements\n- [active] R1: test\n',
    sessionId: 'session-123',
    systemPrompt: 'diff prompt'
  });
  const customDiffArgs = buildPlanDiffArgs({
    newText: 'new requirement',
    currentPlan: '# plan',
    goalText: '# GOAL\n\n## Requirements\n- [active] R1: test\n',
    sessionId: 'session-123',
    model: 'claude-opus-test',
    effort: 'xhigh',
    systemPrompt: 'diff prompt'
  });
  const resumeArgs = buildInitialPlannerResumeArgs({
    goalText: '# GOAL\n\n## Requirements\n- [active] R1: test\n',
    sessionId: 'session-abc',
    question: 'Which host?',
    answer: 'Use the host in the chat request.',
    effort: 'default',
    systemPrompt: 'planner prompt'
  });
  const chatArgs = buildChatArgs({
    userPrompt: 'hello',
    systemPrompt: 'chat prompt',
    model: 'claude-chat-test',
    effort: 'low'
  });
  const codexChatArgs = buildCodexChatArgs({
    target: resolve('fixture/slow-target'),
    prompt: 'chat with read-only context',
    outputLastMessage: '.wici/artifacts/chat-codex-test.txt',
    model: 'gpt-5.5',
    effort: 'medium'
  });
  const resumeCodexChatArgs = buildCodexChatArgs({
    target: resolve('fixture/slow-target'),
    prompt: 'chat follow-up',
    outputLastMessage: '.wici/artifacts/chat-codex-test-2.txt',
    model: 'gpt-5.5',
    effort: 'xhigh',
    resumeSessionId: 'chat-session-123'
  });
  const firstCodex = buildExecutorArgs({
    iter: 1,
    target: resolve('fixture/slow-target'),
    artifactPath: '.wici/artifacts/iter-1.txt',
    schemaPath: schemaPath('iter-result'),
    prompt: 'execute'
  });
  const resumeCodex = buildExecutorArgs({
    iter: 2,
    target: resolve('fixture/slow-target'),
    artifactPath: '.wici/artifacts/iter-2.txt',
    schemaPath: schemaPath('iter-result'),
    prompt: 'resume'
  });
  const sparkCodex = buildExecutorArgs({
    iter: 1,
    target: resolve('fixture/slow-target'),
    artifactPath: '.wici/artifacts/iter-spark.txt',
    schemaPath: schemaPath('iter-result'),
    prompt: 'execute cheaply',
    model: 'gpt-5.3-codex-spark'
  });
  const highEffortCodex = buildExecutorArgs({
    iter: 1,
    target: resolve('fixture/slow-target'),
    artifactPath: '.wici/artifacts/iter-high.txt',
    schemaPath: schemaPath('iter-result'),
    prompt: 'execute carefully',
    effort: 'high'
  });

  assert(plannerArgs[plannerArgs.indexOf('--output-format') + 1] === 'stream-json', 'initial planner must stream JSON for progress visibility');
  assert(plannerArgs.includes('--verbose'), 'stream-json planner output must use Claude verbose mode');
  assert(!plannerArgs.includes('--effort'), 'initial planner must omit --effort for Claude default effort fast validation runs');
  assert(customPlannerArgs[customPlannerArgs.indexOf('--model') + 1] === 'claude-sonnet-test', 'planner must support explicit model selection');
  assert(customPlannerArgs[customPlannerArgs.indexOf('--effort') + 1] === 'high', 'planner must support explicit effort selection');
  assert(customDiffArgs[customDiffArgs.indexOf('--model') + 1] === 'claude-opus-test', 'planner diff must support explicit model selection');
  assert(customDiffArgs[customDiffArgs.indexOf('--effort') + 1] === 'xhigh', 'planner diff must support explicit effort selection');
  assert(chatArgs[chatArgs.indexOf('--model') + 1] === 'claude-chat-test', 'Chat agent must support explicit model selection');
  assert(chatArgs[chatArgs.indexOf('--effort') + 1] === 'low', 'Chat agent must support explicit effort selection');
  assert(codexChatArgs[0] === 'exec' && codexChatArgs.includes('--json') && codexChatArgs.includes('--output-last-message'), 'Codex Chat must use codex exec JSON output, not Claude print args');
  assert(codexChatArgs[codexChatArgs.indexOf('--model') + 1] === 'gpt-5.5', 'Codex Chat must receive the fixed Codex model');
  assert(codexChatArgs.includes('-c') && codexChatArgs.includes('model_reasoning_effort="medium"'), 'Codex Chat must map effort to Codex config override');
  assert(!chatArgs.includes('--permission-mode') || chatArgs[chatArgs.indexOf('--permission-mode') + 1] !== 'plan', 'Chat agent must not be forced into Claude plan mode');
  assert(codexChatArgs[codexChatArgs.indexOf('--sandbox') + 1] === 'workspace-write', 'Codex Chat must support lightweight direct edits instead of read-only-only turns');
  assert(!codexChatArgs.includes('-p') && !codexChatArgs.includes('--permission-mode'), 'Codex Chat must not receive Claude-only arguments');
  assert(!codexChatArgs.includes('--ephemeral'), 'Codex Chat must persist its own session instead of running ephemerally');
  assert(resumeCodexChatArgs[0] === 'exec' && resumeCodexChatArgs[1] === 'resume', `Codex Chat follow-up must resume its session: ${resumeCodexChatArgs.join(' ')}`);
  assert(resumeCodexChatArgs.includes('chat-session-123') && !resumeCodexChatArgs.includes('-C'), `Codex Chat resume must use the session id and spawn cwd, not -C: ${resumeCodexChatArgs.join(' ')}`);
  assert(resumeCodexChatArgs.includes('model_reasoning_effort="xhigh"'), 'Codex Chat resume must apply changed effort without changing session');
  assert(extractCodexSessionId(JSON.stringify({ type: 'thread.started', thread_id: 'chat-session-123' })) === 'chat-session-123', 'Codex Chat must extract thread_id session ids');
  assert(!plannerArgs[plannerArgs.indexOf('-p') + 1].includes('ULTRAPLAN'), 'planner prompt must not force ultra/high-effort wording');
  assert(!plannerArgs.includes('--json-schema'), 'initial planner must not use a JSON schema as a second PLAN');
  assert(!diffArgs.includes('--json-schema'), 'diff planner must not use a JSON schema as a second PLAN');
  assert(diffArgs[diffArgs.indexOf('--output-format') + 1] === 'stream-json', 'diff planner must stream JSON for usage visibility');
  assert(diffArgs.includes('--verbose'), 'diff planner stream-json must use verbose mode');
  assert(plannerArgs[plannerArgs.indexOf('--permission-mode') + 1] === 'plan', 'initial planner must run Claude Code in plan mode');
  assert(diffArgs[diffArgs.indexOf('--permission-mode') + 1] === 'plan', 'diff planner must run Claude Code in plan mode');
  assert(resumeArgs[resumeArgs.indexOf('--permission-mode') + 1] === 'plan', 'planner clarification resume must run Claude Code in plan mode');
  assert(plannerArgs.includes('--dangerously-skip-permissions'), 'initial planner must preserve native Claude Code autonomy for plan mode');
  assert(diffArgs.includes('--dangerously-skip-permissions'), 'planner diff must preserve native Claude Code autonomy for plan mode');
  assert(resumeArgs.includes('--dangerously-skip-permissions'), 'planner clarification resume must preserve native Claude Code autonomy for plan mode');
  assert(resumeArgs[resumeArgs.indexOf('--resume') + 1] === 'session-abc', 'planner clarification resume must target the Claude session');
  assert(!plannerArgs.includes('--tools') && !diffArgs.includes('--tools'), 'planner must not override Claude native tool availability');
  assert(!plannerArgs.includes('--disallowedTools') && !diffArgs.includes('--disallowedTools'), 'planner must not override Claude native tool denials');
  assert(diffArgs[diffArgs.indexOf('-p') + 1].includes('Current GOAL.md:'), 'planner diff must pass markdown GOAL.md text');
  assert(!diffArgs[diffArgs.indexOf('-p') + 1].includes('"requirements"'), 'planner diff must not expose internal goal.json as the goal contract');

  const plannerPrompt = await readFile(promptPath('planner'), 'utf8');
  const chatPrompt = await readFile(promptPath('chat'), 'utf8');
  assert(chatPrompt.includes('lightweight direct work'), 'Chat prompt must let Chat handle lightweight direct work');
  assert(chatPrompt.includes('bounded read-only SSH or remote inspection'), 'Chat prompt must allow bounded read-only SSH or remote inspection');
  assert(chatPrompt.includes('simple local edits'), 'Chat prompt must keep simple edits in Chat instead of forcing planner');
  assert(!chatPrompt.includes('do not run deployment, SSH, or benchmark work yourself'), 'Chat prompt must not route all SSH work to executor');
  assert(!plannerPrompt.includes('unit=ms n=<integer>'), 'planner prompt must not hardcode metric unit=ms');
  assert(!plannerPrompt.includes('unit=<goal metric unit>'), 'planner prompt must not require a fixed GOAL.md metric unit schema');
  assert(plannerPrompt.includes('Fresh V1 does not require `.opt/measure.sh` to follow a WiCi metric schema'), 'planner prompt must keep measurement schemas optional');
  assert(plannerPrompt.includes('you may emit a simple final line such as `METRIC value=<number>'), 'planner prompt may mention METRIC only as an optional task-specific convention');
  assert(!plannerPrompt.includes('WiCi treats `value` as the primary scalar'), 'planner prompt must not make WiCi value parsing part of fresh V1');
  assert(plannerPrompt.includes('## PLAN.md'), 'planner prompt must request markdown PLAN.md artifacts');
  assert(plannerPrompt.includes('## GOAL.md'), 'planner prompt must allow optional markdown GOAL.md artifacts');
  assert(plannerPrompt.includes('Native Claude Code tools remain available in plan mode'), 'planner prompt must preserve native Claude plan-mode tools');
  assert(plannerPrompt.includes('web research or remote discovery'), 'planner prompt must allow planning-time web and remote discovery');
  assert(plannerPrompt.includes('Do not produce a second JSON representation'), 'planner prompt must prohibit JSON-as-plan');
  assert(plannerPrompt.includes('a PLAN.md-only workflow is valid'), 'planner prompt must not force .opt scripts for fresh V1 plans');
  assert(plannerPrompt.includes('Do not create scripts just to satisfy WiCi'), 'planner prompt must keep validation scripts optional');
  assert(plannerPrompt.includes('this is optional and task-specific rather than a supervisor baseline gate'), 'planner prompt must not turn measure scripts into a supervisor gate');

  const structured = extractStructured(
    [
      JSON.stringify({ type: 'system', session_id: 'session-abc' }),
      JSON.stringify({
        type: 'result',
        session_id: 'session-abc',
        result: [
          '## PLAN.md',
          '',
          '# Plan',
          '- [ ] S1 Test',
          '',
          '## .opt/measure.sh',
          '',
          'echo METRIC value=1 unit=score n=5 warmup_discarded=0',
          '',
          '## .opt/checks.sh',
          '',
          'echo ok'
        ].join('\n')
      })
    ].join('\n')
  );
  assert(structured.session_id === 'session-abc', 'planner parser must preserve Claude envelope session id');
  assert(typeof structured.planMarkdown === 'string', 'planner parser must return plan markdown');
  assert(structured.planMarkdown.includes('S1'), 'planner parser must extract markdown artifacts from Claude result envelope');

  const question = extractPlannerResponse(
    JSON.stringify({
      type: 'result',
      session_id: 'session-question',
      result: '## QUESTION\n\nWhich remote host should I plan against?'
    })
  );
  assert(question.kind === 'question', 'planner parser must surface clarification questions');
  assert(question.question.session_id === 'session-question', 'planner parser must preserve clarification session id');
  assert(question.question.question.includes('remote host'), 'planner parser must preserve clarification text');

  assertThrows(
    () =>
      extractStructured(
        JSON.stringify({
          type: 'result',
          session_id: 'session-json-plan',
          result: JSON.stringify({
            planMarkdown: '# Plan\n- [ ] S1 Test',
            measureSh: 'echo METRIC value=1 unit=score n=5 warmup_discarded=0',
            checksSh: 'echo ok'
          })
        })
      ),
    'planner parser must reject JSON-as-plan artifacts'
  );
  assertThrows(
    () =>
      extractPlannerResponse(
        JSON.stringify({
          type: 'result',
          session_id: 'session-json-question',
          result: JSON.stringify({
            question: 'Which remote host should I plan against?'
          })
        })
      ),
    'planner parser must reject JSON clarification payloads'
  );

  const fence = '```';
  const markdownArtifactStructured = extractStructured(
    JSON.stringify({
      type: 'result',
      session_id: 'session-markdown-artifacts',
      result: [
        'Planner notes before artifacts.',
        '',
        '## GOAL.md',
        '',
        `${fence}markdown`,
        '# GOAL',
        '',
        '- Raw requirement: keep the original user text.',
        fence,
        '',
        '## PLAN.md',
        '',
        `${fence}markdown`,
        '# PLAN',
        '',
        '## Config contract',
        '',
        fence,
        'A=1',
        fence,
        '',
        '## Steps',
        '',
        '### S1 — Do it',
        '- Action: preserve nested fences while parsing the artifact.',
        fence,
        '',
        '## .opt/checks.sh',
        '',
        `${fence}bash`,
        'echo ok',
        fence
      ].join('\n')
    })
  );
  assert(markdownArtifactStructured.goalMarkdown?.includes('Raw requirement'), 'markdown artifact parser must extract optional GOAL.md');
  assert(markdownArtifactStructured.planMarkdown?.includes('### S1'), 'markdown artifact parser must not truncate PLAN.md at inner headings');
  assert(markdownArtifactStructured.planMarkdown?.includes('A=1'), 'markdown artifact parser must preserve inner fenced blocks');
  assert(markdownArtifactStructured.checksSh === 'echo ok', 'markdown artifact parser must extract following shell artifacts');

  const progress = plannerProgressFromLine(
    JSON.stringify({
      type: 'assistant',
      session_id: 'session-abc',
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 2
        }
      }
    })
  );
  assert(progress?.usage.input_tokens === 10, 'planner usage parser must extract input tokens from stream-json events');
  const systemProgress = plannerProgressFromLine(
    JSON.stringify({
      type: 'system',
      session_id: 'session-abc',
      usage: {
        total_tokens: 16152,
        tool_uses: 1,
        duration_ms: 13532
      }
    })
  );
  assert(systemProgress?.usage.total_tokens === 16152, 'planner usage parser must extract system total tokens from stream-json events');

  assert(firstCodex.includes('--output-schema'), 'first codex exec missing --output-schema');
  assert(firstCodex.includes('--output-last-message'), 'first codex exec missing --output-last-message');
  assert(resumeCodex.includes('--output-schema'), 'codex resume missing --output-schema');
  assert(resumeCodex.includes('--output-last-message'), 'codex resume missing --output-last-message');
  assert(resumeCodex.includes('--skip-git-repo-check'), 'codex resume missing --skip-git-repo-check');
  assert(!resumeCodex.includes('-C'), `codex resume must rely on process cwd instead of unsupported -C: ${resumeCodex.join(' ')}`);
  assert(!firstCodex.includes('gpt-5.3-codex-spark'), 'spark model must not be hardcoded into default executor args');
  assert(sparkCodex[sparkCodex.indexOf('--model') + 1] === 'gpt-5.3-codex-spark', 'executor must support explicit model override for real canaries');
  assert(highEffortCodex.includes('-c') && highEffortCodex.includes('model_reasoning_effort="high"'), 'executor must map effort selection to Codex config override');
  const loadedConfig = await loadConfig('stub');
  assert(loadedConfig.tools.chat?.command === 'claude', 'default config should expose Chat agent command');
  assert(loadedConfig.tools.chat?.model === 'opus4.8' && loadedConfig.tools.planner.model === 'opus4.8', 'Claude-backed panes must force opus4.8 by default');
  assert(loadedConfig.tools.chat?.effort === 'high' && loadedConfig.tools.planner.effort === 'high', 'Claude-backed panes must default to high effort');
  assert(loadedConfig.tools.executor.model === 'gpt-5.5' && loadedConfig.tools.executor.effort === 'medium', 'Codex-backed executor must force gpt-5.5 medium by default');
  const switchedConfig = await loadConfig('stub');
  applyRuntimeSelection(switchedConfig, { planner: { agent: 'codex', effort: 'fast' }, executor: { agent: 'claude', effort: 'ultracode' } });
  assert(switchedConfig.tools.planner.command === 'codex', 'runtime agent switch must allow planner pane to select codex');
  assert(switchedConfig.tools.planner.model === 'gpt-5.5' && switchedConfig.tools.planner.effort === 'fast', 'codex agent selection must force gpt-5.5 and codex effort options');
  assert(switchedConfig.tools.executor.command === 'claude', 'runtime agent switch must allow execution pane to select claude');
  assert(switchedConfig.tools.executor.model === 'opus4.8' && switchedConfig.tools.executor.effort === 'ultracode', 'claude agent selection must force opus4.8 and claude effort options');
  assert(loadedConfig.budget.max_iters === 0, 'default config max_iters=0 should disable WiCi iteration hard caps for real runs');
  assert(resolveMaxIters(undefined, loadedConfig.budget.max_iters) === Number.POSITIVE_INFINITY, 'configured max_iters=0 should resolve to unbounded');
  assert(resolveMaxIters(0, loadedConfig.budget.max_iters) === 0, 'explicit --max-iters 0 should remain a setup-only run limit');
  assert(resolveMaxIters(1, loadedConfig.budget.max_iters) === 1, 'explicit --max-iters should override the unbounded default');
  assert(iterSchema.additionalProperties === false, 'codex output schema root must set additionalProperties=false');
  const headingSteps = parsePlanSteps('# Plan\n\n## Steps\n\n### S1 — SSH connectivity\n- Action: connect\n\n### S2 - Measure throughput <!-- status:active iter:1 -->\n');
  assert(headingSteps.length === 2, `planner heading steps should be executable: ${JSON.stringify(headingSteps)}`);
  assert(headingSteps[0].id === 'S1' && headingSteps[0].status === 'pending', 'heading step S1 should default to pending');
  assert(headingSteps[1].id === 'S2' && headingSteps[1].status === 'active', 'heading step S2 should read status comments');
  await verifyInitialPlannerDoesNotInferBenchmark();
  await verifyPlanDiffUsage();
  await verifyCodexChatAgent();

  const codexResumeHelp = await execa('codex', ['exec', 'resume', '--help'], { all: true, reject: false });
  assert((codexResumeHelp.all ?? '').includes('--output-schema <FILE>'), 'local codex resume help does not advertise --output-schema');
  assert((codexResumeHelp.all ?? '').includes('--output-last-message <FILE>'), 'local codex resume help does not advertise --output-last-message');

  console.log(
    JSON.stringify(
      {
        ok: true,
        claude_markdown_plan: true,
        planner_json_plan_rejected: true,
        claude_plan_mode: true,
        initial_plan_usage_streamed: true,
        plan_diff_usage_streamed: true,
        codex_chat_agent: true,
        no_markdown_benchmark_inference: true,
        codex_output_schema_strict: true,
        forced_agent_models: true,
        default_iteration_budget_unbounded: true,
        codex_resume_structured_output_flags: true
      },
      null,
      2
    )
  );
}

async function verifyCodexChatAgent(): Promise<void> {
  const target = resolve('fixture/codex-chat-agent-target');
  const fakeBin = resolve('fixture/codex-chat-agent-bin');
  await rm(target, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const fakeCodex = join(fakeBin, 'codex');
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.999.0');
  process.exit(0);
}
const target = process.env.WICI_CODEX_CHAT_TARGET;
const out = args[args.indexOf('--output-last-message') + 1];
const resumeIndex = args.indexOf('resume');
const resumed = resumeIndex >= 0;
mkdirSync(dirname(out), { recursive: true });
mkdirSync(join(target, '.wici'), { recursive: true });
appendFileSync(join(target, '.wici', 'fake-codex-chat-args.jsonl'), JSON.stringify({ args }) + '\\n');
writeFileSync(out, [
  '## REPLY',
  '',
  resumed ? 'Codex Chat resumed the same session.' : 'Codex Chat can discuss this before planning.',
  '',
  '## UPDATE',
  '',
  'kind: requirement',
  'Build the requested feature after planning.'
].join('\\n'));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-chat-session' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'unused fallback' } }));
`
  );
  await chmod(fakeCodex, 0o755);

  const paths = runPaths(target);
  await ensureRunDirs(paths);
  const originalPath = process.env.PATH;
  const originalTarget = process.env.WICI_CODEX_CHAT_TARGET;
  process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
  process.env.WICI_CODEX_CHAT_TARGET = target;
  try {
    const result = await runChatTurn({
      paths,
      userText: 'Start planning after this.',
      goalDoc: '',
      plan: '',
      recentEvents: [],
      mode: 'real',
      runtime: { chat: { agent: 'codex', effort: 'medium' } },
      writeUpdate: false
    });
    assert(!result.degraded, `Codex Chat should not degrade through Claude fallback: ${JSON.stringify(result)}`);
    assert(result.reply.includes('Codex Chat can discuss'), `Codex Chat reply not parsed: ${JSON.stringify(result)}`);
    assert(result.update?.text.includes('Build the requested feature'), `Codex Chat update not parsed: ${JSON.stringify(result)}`);
    const followUp = await runChatTurn({
      paths,
      userText: 'Use higher effort but keep this chat context.',
      goalDoc: '',
      plan: '',
      recentEvents: [],
      mode: 'real',
      runtime: { chat: { agent: 'codex', effort: 'xhigh' } },
      writeUpdate: false
    });
    assert(!followUp.degraded, `Codex Chat follow-up should resume without degrading: ${JSON.stringify(followUp)}`);
    assert(followUp.reply.includes('resumed the same session'), `Codex Chat follow-up did not parse resumed reply: ${JSON.stringify(followUp)}`);
    const argsLog = (await readFile(join(paths.wici, 'fake-codex-chat-args.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] });
    assert(argsLog.length === 2, `Codex Chat should have two invocations: ${JSON.stringify(argsLog)}`);
    assert(argsLog[0].args.includes('--sandbox') && argsLog[0].args.includes('workspace-write'), `Codex Chat did not use lightweight direct-work sandbox: ${JSON.stringify(argsLog)}`);
    assert(!argsLog[0].args.includes('--permission-mode') && !argsLog[1].args.includes('--permission-mode'), `Codex Chat received Claude-only args: ${JSON.stringify(argsLog)}`);
    assert(argsLog[0].args[0] === 'exec' && argsLog[0].args[1] !== 'resume', `first Codex Chat call should start a persistent session: ${JSON.stringify(argsLog[0].args)}`);
    assert(!argsLog[0].args.includes('--ephemeral'), `first Codex Chat call must not be ephemeral: ${JSON.stringify(argsLog[0].args)}`);
    assert(argsLog[1].args[0] === 'exec' && argsLog[1].args[1] === 'resume', `second Codex Chat call must resume: ${JSON.stringify(argsLog[1].args)}`);
    assert(argsLog[1].args.includes('fake-codex-chat-session'), `second Codex Chat call must resume the recorded chat session: ${JSON.stringify(argsLog[1].args)}`);
    assert(argsLog[1].args.includes('model_reasoning_effort="xhigh"'), `second Codex Chat call must apply the changed effort: ${JSON.stringify(argsLog[1].args)}`);
    const session = JSON.parse(await readFile(paths.chatSession, 'utf8')) as { sessions?: { codex?: { session_id?: string } } };
    assert(session.sessions?.codex?.session_id === 'fake-codex-chat-session', `Codex Chat session was not stored by agent: ${JSON.stringify(session)}`);
  } finally {
    process.env.PATH = originalPath;
    if (originalTarget === undefined) delete process.env.WICI_CODEX_CHAT_TARGET;
    else process.env.WICI_CODEX_CHAT_TARGET = originalTarget;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => unknown, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

async function verifyPlanDiffUsage(): Promise<void> {
  const target = resolve('fixture/planner-diff-usage-target');
  const fakeBin = resolve('fixture/planner-diff-usage-bin');
  await rm(target, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const fakeClaude = join(fakeBin, 'claude');
  await writeFile(
    fakeClaude,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.1.999 (Fake Claude Code)');
  process.exit(0);
}
console.log(JSON.stringify({
  type: 'assistant',
  session_id: 'fake-diff-session',
  message: { usage: { input_tokens: 17, output_tokens: 5 } }
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'fake-diff-session',
  result: [
    '## PLAN.md',
    '',
    '# Updated Plan',
    '',
    '- [ ] S1 Handle the new chat requirement'
  ].join('\\n')
}));
`
  );
  await chmod(fakeClaude, 0o755);

  const paths = runPaths(target);
  await ensureRunDirs(paths);
  const config = (await loadConfig('real')) as WiCiConfig;
  config.tools.planner.command = fakeClaude;
  const goal: GoalFile = {
    run_id: 'planner-diff-usage',
    version: 1,
    requirements: [{ id: 'R1', text: 'Verify planner diff token usage streaming.', source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'planner-selected validation', direction: 'maximize', target: null, unit: 'score' },
    budget: config.budget,
    stop: config.stop
  };
  await atomicWriteJson(paths.goal, goal);
  await writeFile(paths.goalDoc, '# GOAL\n\nVerify planner diff token usage streaming.\n');
  await writeFile(paths.plan, '# Initial Plan\n\n- [ ] S1 Initial step\n');

  const progress: unknown[] = [];
  const result = await runPlanDiff(paths, goal, 'fake-diff-session', 'new chat requirement', config, async (item) => {
    progress.push(item);
  });
  assert(result.ok, `planner diff should succeed: ${JSON.stringify(result)}`);
  assert(progress.length > 0, 'planner diff did not stream PLAN_USAGE progress');
  assert((progress[0] as { usage?: { input_tokens?: number } }).usage?.input_tokens === 17, `unexpected planner diff usage: ${JSON.stringify(progress)}`);
  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('Handle the new chat requirement'), `planner diff did not materialize markdown PLAN.md:\n${plan}`);
}

async function verifyInitialPlannerDoesNotInferBenchmark(): Promise<void> {
  const target = resolve('fixture/planner-no-benchmark-inference-target');
  const fakeBin = resolve('fixture/planner-no-benchmark-inference-bin');
  await rm(target, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const fakeClaude = join(fakeBin, 'claude');
  await writeFile(
    fakeClaude,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('2.1.999 (Fake Claude Code)');
  process.exit(0);
}
console.log(JSON.stringify({
  type: 'assistant',
  session_id: 'fake-initial-session',
  message: { usage: { input_tokens: 23, output_tokens: 7 } }
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'fake-initial-session',
  result: [
    '## PLAN.md',
    '',
    '# Plan',
    '',
    '## BENCHMARK',
    '',
    '- tool: curl',
    '- command: ./.opt/measure.sh',
    '- metric: generated_throughput',
    '- direction: maximize',
    '- target: 700',
    '- unit: token/s',
    '- reason: This is planner prose inside PLAN.md, not a WiCi schema.',
    '',
    '## Steps',
    '',
    '- [ ] S1 Let Codex run the planner-selected validation.',
    '',
    '## .opt/measure.sh',
    '',
    'echo METRIC value=701 unit=token/s n=1 warmup_discarded=0',
    '',
    '## .opt/checks.sh',
    '',
    'echo ok'
  ].join('\\n')
}));
`
  );
  await chmod(fakeClaude, 0o755);

  const paths = runPaths(target);
  await ensureRunDirs(paths);
  const config = (await loadConfig('real')) as WiCiConfig;
  config.tools.planner.command = fakeClaude;
  const goal: GoalFile = {
    run_id: 'planner-no-benchmark-inference',
    version: 1,
    requirements: [{ id: 'R1', text: 'Do not parse planner markdown into supervisor benchmark semantics.', source: 'initial', status: 'active' }],
    acceptance_criteria: [],
    constraints: [],
    metric: { name: 'planner-selected validation', direction: 'maximize', target: null, unit: 'score' },
    budget: config.budget,
    stop: config.stop
  };
  await atomicWriteJson(paths.goal, goal);
  await writeFile(paths.goalDoc, '# GOAL\n\nDo not parse planner markdown into supervisor benchmark semantics.\n');

  const progress: unknown[] = [];
  const result = await runInitialPlanner(paths, goal, config, async (item) => {
    progress.push(item);
  });
  assert(result.ok, `initial planner should succeed: ${JSON.stringify(result)}`);
  assert(progress.length > 0, 'initial planner did not stream PLAN_USAGE progress');
  assert((progress[0] as { usage?: { input_tokens?: number } }).usage?.input_tokens === 23, `unexpected initial planner usage: ${JSON.stringify(progress)}`);
  assert(!(await exists(paths.benchmarkManifest)), 'fresh planner materialization must not infer .opt/benchmark.json from PLAN.md prose');
  const savedGoal = JSON.parse(await readFile(paths.goal, 'utf8')) as GoalFile;
  assert(savedGoal.metric.name === goal.metric.name, `fresh planner materialization must not rewrite goal metric: ${JSON.stringify(savedGoal.metric)}`);
  const plan = await readFile(paths.plan, 'utf8');
  assert(plan.includes('This is planner prose inside PLAN.md'), `planner prose was not preserved in PLAN.md:\n${plan}`);
}

await main();
