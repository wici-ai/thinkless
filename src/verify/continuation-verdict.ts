import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSampleTarget } from '../sample.js';
import { runPaths } from '../shared/paths.js';
import type { GoalFile, WiCiConfig } from '../shared/types.js';
import { directContinuationVerdict } from '../supervisor/stop.js';

const target = resolve('fixture/continuation-verdict-target');
const fakeBin = resolve('fixture/continuation-verdict-bin');

async function main(): Promise<void> {
  await installFakeClaude();
  const originalPath = process.env.PATH ?? '';
  process.env.PATH = `${fakeBin}:${originalPath}`;
  try {
    await createSampleTarget(target, true);
    const paths = runPaths(target);
    await writeFile(paths.assumptions, '# Assumptions\n\n## Approaches considered\n- Verify before stopping.\n');

    await writeFile(paths.goalDoc, '# complete-goal\n\nAll acceptance evidence is present.\n');
    const complete = await directContinuationVerdict(paths, goal('complete-goal'), [], config('auto', 'claude'));
    assert(complete.decision === 'complete', `expected explicit complete verdict, got ${JSON.stringify(complete)}`);
    assert(complete.source === 'llm', 'complete verdict should come from fake LLM');

    await writeFile(paths.goalDoc, '# continue-goal\n\nEvidence is still missing.\n');
    const keepGoing = await directContinuationVerdict(paths, goal('continue-goal'), [], config('auto', 'claude'));
    assert(keepGoing.decision === 'continue', `expected explicit continue verdict, got ${JSON.stringify(keepGoing)}`);
    assert(keepGoing.source === 'llm', 'continue verdict should come from fake LLM');

    await writeFile(paths.goalDoc, '# codex-complete-goal\n\nAll acceptance evidence is present.\n');
    const codexComplete = await directContinuationVerdict(paths, goal('codex-complete-goal'), [], config('auto', 'codex'));
    assert(codexComplete.decision === 'complete', `expected Codex explicit complete verdict, got ${JSON.stringify(codexComplete)}`);
    assert(codexComplete.source === 'llm', 'Codex complete verdict should come from fake LLM');

    await writeFile(paths.goalDoc, '# ambiguous-goal\n\nThe fake LLM will return unusable output.\n');
    const ambiguous = await directContinuationVerdict(paths, goal('ambiguous-goal'), [], config('auto', 'claude'));
    assert(ambiguous.decision === 'continue', `ambiguous verdict must fall back to continue, got ${JSON.stringify(ambiguous)}`);
    assert(ambiguous.source === 'fallback', 'ambiguous verdict should use continue-biased fallback');

    const stub = await directContinuationVerdict(paths, goal('stub-goal'), [], config('stub', 'codex'));
    assert(stub.decision === 'continue' && stub.source === 'fallback', `stub mode must continue, got ${JSON.stringify(stub)}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          explicit_complete_stops: true,
          explicit_continue_continues: true,
          codex_planner_verdict_supported: true,
          ambiguous_falls_back_to_continue: true,
          stub_falls_back_to_continue: true
        },
        null,
        2
      )
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(target, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
}

async function installFakeClaude(): Promise<void> {
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  const claudeScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.1.999 (Fake Claude Code)');
  process.exit(0);
}
const prompt = args[args.indexOf('-p') + 1] || '';
if (!prompt.includes('Bias toward') || !prompt.includes('ASSUMPTIONS.md')) {
  console.error('completion gate prompt missing required context');
  process.exit(2);
}
if (prompt.includes('complete-goal')) {
  console.log(JSON.stringify({ type: 'result', result: '{"decision":"complete","reason":"all active requirements and acceptance evidence are satisfied"}' }));
  process.exit(0);
}
if (prompt.includes('continue-goal')) {
  console.log(JSON.stringify({ type: 'result', result: '{"decision":"continue","reason":"acceptance evidence is still missing"}' }));
  process.exit(0);
}
console.log('not json');
process.exit(0);
`;
  const fakeClaude = join(fakeBin, 'claude');
  await writeFile(fakeClaude, claudeScript);
  await chmod(fakeClaude, 0o755);

  const codexScript = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] !== 'exec') {
  console.error('fake Codex expected exec, got ' + args.join(' '));
  process.exit(2);
}
if (args.includes('--output-format') || args.includes('--permission-mode')) {
  console.error('fake Codex received Claude-only arguments: ' + args.join(' '));
  process.exit(2);
}
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) {
  console.error('fake Codex missing --output-last-message');
  process.exit(2);
}
const prompt = args[args.length - 1] || '';
if (!prompt.includes('Bias toward') || !prompt.includes('ASSUMPTIONS.md')) {
  console.error('completion gate prompt missing required context');
  process.exit(2);
}
const outputPath = args[outputIndex + 1];
if (prompt.includes('codex-complete-goal')) {
  writeFileSync(outputPath, '{"decision":"complete","reason":"codex path saw complete evidence"}\\n');
  console.log(JSON.stringify({ type: 'agent_message', text: '{"decision":"complete","reason":"codex path saw complete evidence"}' }));
  process.exit(0);
}
writeFileSync(outputPath, 'not json\\n');
console.log('not json');
process.exit(0);
`;
  const fakeCodex = join(fakeBin, 'codex');
  await writeFile(fakeCodex, codexScript);
  await chmod(fakeCodex, 0o755);
}

function goal(text: string): GoalFile {
  return {
    run_id: `continuation-${text}`,
    version: 1,
    requirements: [{ id: 'R1', text, source: 'initial', status: 'active' }],
    acceptance_criteria: [{ id: 'A1', text: 'evidence recorded', check: 'inspect ledger and artifacts' }],
    constraints: [],
    metric: { name: 'planner selected validation', direction: 'maximize', target: null, unit: 'score' },
    budget: { max_iters: 0, max_cost_usd: 0, deadline: null },
    stop: { tau: 0.01, K: 3, N: 4, mode: 'auto' }
  };
}

function config(mode: WiCiConfig['tools']['mode'], plannerCommand: 'claude' | 'codex'): WiCiConfig {
  return {
    tools: {
      mode,
      planner: { command: plannerCommand, effort: plannerCommand === 'codex' ? 'xhigh' : 'default', model: plannerCommand === 'codex' ? 'gpt-5.5' : undefined },
      executor: { command: 'codex', dangerouslyBypassApprovalsAndSandbox: true }
    },
    budget: { max_iters: 0, max_cost_usd: 0, deadline: null },
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
