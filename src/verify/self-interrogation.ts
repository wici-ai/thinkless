import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { exists } from '../shared/atomic.js';
import { runPaths } from '../shared/paths.js';
import { runSupervisor } from '../supervisor/index.js';

const target = resolve('fixture/self-interrogation-target');
const fakeBin = resolve('fixture/self-interrogation-bin');

async function main(): Promise<void> {
  await installFakePlanner();
  const originalPath = process.env.PATH ?? '';
  const originalAutoUpdate = process.env.WICI_AUTO_UPDATE_TOOLS;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  process.env.WICI_AUTO_UPDATE_TOOLS = '0';
  try {
    await createSampleTarget(target, true);
    const paths = runPaths(target);
    const result = await runSupervisor({
      target,
      goal: 'Plan a safe optimization while recording the planner assumptions.',
      maxIters: 0,
      mode: 'auto',
      runtime: { planner: { agent: 'claude' } }
    });
    assert(result.state === 'STOP', `expected setup-only stop, got ${JSON.stringify(result)}`);
    assert(result.reason === 'Reached max_iters=0', `unexpected stop reason: ${result.reason}`);
    assert(await exists(paths.assumptions), 'planner did not materialize ASSUMPTIONS.md');

    const assumptions = await readFile(paths.assumptions, 'utf8');
    assert(assumptions.includes('## Approaches considered'), 'ASSUMPTIONS.md missing approaches section');
    assert(assumptions.includes('## Assumptions adopted'), 'ASSUMPTIONS.md missing adopted assumptions section');
    assert(assumptions.includes('## Open risks'), 'ASSUMPTIONS.md missing open risks section');

    const plannerPrompt = await readFile('prompts/planner.md', 'utf8');
    const diffPrompt = await readFile('prompts/planner-diff.md', 'utf8');
    assert(plannerPrompt.includes('Brainstorm 2-3'), 'planner prompt must require 2-3 approach brainstorming');
    assert(plannerPrompt.includes('Self-grill'), 'planner prompt must require self-grilling');
    assert(plannerPrompt.includes('ASSUMPTIONS.md'), 'planner prompt must request ASSUMPTIONS.md');
    assert(plannerPrompt.includes('unresolvable by repository evidence'), 'planner prompt must narrow QUESTION to unresolvable essentials');
    assert(diffPrompt.includes('living self-interrogation artifact'), 'planner-diff prompt must maintain ASSUMPTIONS.md');
    assert(diffPrompt.includes('authoritative evidence that can override an adopted assumption'), 'planner-diff prompt must treat steering as an assumption override');

    console.log(
      JSON.stringify(
        {
          ok: true,
          target,
          assumptions_materialized: true,
          question_gate_narrowed: true,
          planner_diff_maintains_assumptions: true
        },
        null,
        2
      )
    );
  } finally {
    process.env.PATH = originalPath;
    if (originalAutoUpdate === undefined) {
      delete process.env.WICI_AUTO_UPDATE_TOOLS;
    } else {
      process.env.WICI_AUTO_UPDATE_TOOLS = originalAutoUpdate;
    }
    await rm(target, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
}

async function installFakePlanner(): Promise<void> {
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.1.999 (Fake Claude Code)');
  process.exit(0);
}
if (args[0] === 'update') {
  console.log('ok');
  process.exit(0);
}
const result = [
  '## ASSUMPTIONS.md',
  '',
  '# Assumptions',
  '',
  '## Approaches considered',
  '- Keep the fixture validation direct and optimize the hot path after inspecting current behavior.',
  '- Add a reusable script wrapper only if the existing scripts are insufficient.',
  '',
  '## Assumptions adopted',
  '- Existing npm scripts are enough initial evidence; Codex can run them during S1.',
  '',
  '## Open risks',
  '- If validation fails, Codex should inspect the failing command before changing scope.',
  '',
  '## PLAN.md',
  '',
  '# WiCi Direct Plan',
  '',
  '- [ ] S1 Inspect and validate the hot path',
  '  - Action: inspect src/hotpath.js and run the existing checks.',
  '  - Validation: npm test',
  '  - Rollback: leave source unchanged if checks fail.'
].join('\\n');
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'fake-self-interrogation-session',
  result
}));
process.exit(0);
`;
  const fakeClaude = join(fakeBin, 'claude');
  await writeFile(fakeClaude, script);
  await chmod(fakeClaude, 0o755);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
