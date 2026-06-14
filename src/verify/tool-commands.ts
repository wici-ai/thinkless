import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { buildExecutorArgs } from '../supervisor/executor.js';
import { buildInitialPlannerArgs, buildPlanDiffArgs } from '../supervisor/planner.js';
import { promptPath, schemaPath } from '../shared/paths.js';

async function main(): Promise<void> {
  const planSchema = await readFile(schemaPath('plan'), 'utf8');
  const diffSchema = await readFile(schemaPath('plan-diff'), 'utf8');
  const plannerArgs = buildInitialPlannerArgs({
    goalText: 'test',
    schema: planSchema,
    effort: 'max',
    systemPrompt: 'planner prompt'
  });
  const diffArgs = buildPlanDiffArgs({
    newText: 'new requirement',
    currentPlan: '# plan',
    goalText: '# GOAL\n\n## Requirements\n- [active] R1: test\n',
    sessionId: 'session-123',
    schema: diffSchema,
    systemPrompt: 'diff prompt'
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

  assert(plannerArgs[plannerArgs.indexOf('--json-schema') + 1].trim().startsWith('{'), 'initial planner must pass JSON schema content');
  assert(!plannerArgs.includes(schemaPath('plan')), 'initial planner must not pass schema file path to claude');
  assert(diffArgs[diffArgs.indexOf('--json-schema') + 1].trim().startsWith('{'), 'diff planner must pass JSON schema content');
  assert(!diffArgs.includes(schemaPath('plan-diff')), 'diff planner must not pass schema file path to claude');
  assert(plannerArgs[plannerArgs.indexOf('--permission-mode') + 1] === 'plan', 'initial planner must run Claude Code in plan mode');
  assert(diffArgs[diffArgs.indexOf('--permission-mode') + 1] === 'plan', 'diff planner must run Claude Code in plan mode');
  assert(!plannerArgs.includes('--dangerously-skip-permissions'), 'planner must not bypass permissions outside plan mode');
  assert(!diffArgs.includes('--dangerously-skip-permissions'), 'planner diff must not bypass permissions outside plan mode');
  assert(diffArgs[diffArgs.indexOf('-p') + 1].includes('Current GOAL.md:'), 'planner diff must pass markdown GOAL.md text');
  assert(!diffArgs[diffArgs.indexOf('-p') + 1].includes('"requirements"'), 'planner diff must not expose internal goal.json as the goal contract');

  const plannerPrompt = await readFile(promptPath('planner'), 'utf8');
  assert(!plannerPrompt.includes('unit=ms n=<integer>'), 'planner prompt must not hardcode metric unit=ms');
  assert(plannerPrompt.includes('unit=<goal metric unit>'), 'planner prompt must require the GOAL.md metric unit');
  assert(plannerPrompt.includes('goal direction determine acceptance'), 'planner prompt must let GOAL.md metric direction control acceptance');

  assert(firstCodex.includes('--output-schema'), 'first codex exec missing --output-schema');
  assert(firstCodex.includes('--output-last-message'), 'first codex exec missing --output-last-message');
  assert(resumeCodex.includes('--output-schema'), 'codex resume missing --output-schema');
  assert(resumeCodex.includes('--output-last-message'), 'codex resume missing --output-last-message');
  assert(resumeCodex.includes('--skip-git-repo-check'), 'codex resume missing --skip-git-repo-check');

  const [claudeHelp, codexResumeHelp] = await Promise.all([
    execa('claude', ['--help'], { all: true, reject: false }),
    execa('codex', ['exec', 'resume', '--help'], { all: true, reject: false })
  ]);
  assert((claudeHelp.all ?? '').includes('--json-schema <schema>'), 'local claude help does not advertise --json-schema <schema>');
  assert((codexResumeHelp.all ?? '').includes('--output-schema <FILE>'), 'local codex resume help does not advertise --output-schema');
  assert((codexResumeHelp.all ?? '').includes('--output-last-message <FILE>'), 'local codex resume help does not advertise --output-last-message');

  console.log(
    JSON.stringify(
      {
        ok: true,
        claude_schema_content: true,
        claude_plan_mode: true,
        codex_resume_structured_output_flags: true
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
