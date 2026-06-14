import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { atomicWriteFile, atomicWriteJson, exists } from '../shared/atomic.js';
import { schemaPath, type RunPaths } from '../shared/paths.js';
import type { GoalFile, IterResult, ToolInvocationResult, WiCiConfig } from '../shared/types.js';
import { CodexRunError, appendCodexRunTranscript, assertCodexRunSucceeded, syntheticCodexRunEvent } from './codexRun.js';

async function commandExists(command: string): Promise<boolean> {
  const result = await execa('command', ['-v', command], { shell: true, reject: false });
  return result.exitCode === 0;
}

export async function runExecutorStep(
  paths: RunPaths,
  goal: GoalFile,
  stepId: string,
  iter: number,
  config: WiCiConfig,
  steerText?: string,
  lessonsText?: string
): Promise<IterResult & { invocation: ToolInvocationResult }> {
  const available = await commandExists(config.tools.executor.command);
  if (config.tools.mode === 'real' && !available) {
    throw new Error(`Executor command not found in real mode: ${config.tools.executor.command}`);
  }

  if (config.tools.mode !== 'stub' && available) {
    try {
      const prompt = [
        iter === 1 ? `Execute plan step ${stepId} from PLAN.md.` : `Continue with plan step ${stepId} from PLAN.md.`,
        steerText ? `NOTE new requirement or steering input: ${steerText}` : '',
        `Use the target repository as the only workspace.`,
        `Do not edit .opt/checks.sh, .opt/measure.sh, or .opt/benchmark.json.`,
        lessonsText ? lessonsText : '',
        `Write result JSON to .wici/artifacts/iter-${iter}.json with shape {step_done,tests_pass,notes,changed_files,next}.`
      ]
        .filter(Boolean)
        .join('\n');

      const artifactPath = join(paths.artifacts, `iter-${iter}.txt`);
      await atomicWriteFile(join(paths.artifacts, `iter-${iter}.prompt.txt`), `${prompt}\n`);
      const args = buildExecutorArgs({
        iter,
        target: paths.target,
        artifactPath,
        schemaPath: schemaPath('iter-result'),
        prompt
      });

      const result = await execa(config.tools.executor.command, args, {
        cwd: paths.target,
        reject: false,
        all: true,
        maxBuffer: 1024 * 1024 * 50
      });
      const stdout = result.all ?? result.stdout;
      const usage = await appendCodexRunTranscript(paths, stdout);
      if (result.exitCode !== 0) {
        throw new CodexRunError(`codex exec exited ${result.exitCode}:\n${stdout}`, usage);
      }
      assertCodexRunSucceeded(usage, 'codex exec reported failure event');
      const iterResult = await readIterResult(paths, iter);
      return { ...iterResult, invocation: { ok: true, stdout, usage } };
    } catch (error) {
      if (config.tools.mode === 'real') throw error;
    }
  }

  const stubPrompt = [
    `Execute plan step ${stepId} from PLAN.md.`,
    steerText ? `NOTE new requirement or steering input: ${steerText}` : '',
    lessonsText ? lessonsText : '',
    `Write result JSON to .wici/artifacts/iter-${iter}.json.`
  ]
    .filter(Boolean)
    .join('\n');
  await atomicWriteFile(join(paths.artifacts, `iter-${iter}.prompt.txt`), `${stubPrompt}\n`);
  const iterResult = await runStubExecutor(paths, goal, stepId, iter);
  const usage = await appendCodexRunTranscript(paths, syntheticCodexRunEvent(iter, iterResult.notes));
  return { ...iterResult, invocation: { ok: true, sessionId: 'stub-executor', stdout: iterResult.notes, usage } };
}

async function readIterResult(paths: RunPaths, iter: number): Promise<IterResult> {
  const path = join(paths.artifacts, `iter-${iter}.json`);
  if (!(await exists(path))) {
    throw new Error(`Executor did not write expected result file: ${path}`);
  }
  return JSON.parse(await readFile(path, 'utf8')) as IterResult;
}

async function runStubExecutor(paths: RunPaths, _goal: GoalFile, stepId: string, iter: number): Promise<IterResult> {
  const hotPath = join(paths.target, 'src', 'hotpath.js');
  const result: IterResult = {
    step_done: false,
    tests_pass: false,
    notes: 'Stub executor found no fixture hotpath.js; wrote a no-op result.',
    changed_files: []
  };

  if (await exists(hotPath)) {
    const current = await readFile(hotPath, 'utf8');
    if (current.includes('for (const candidate of values)')) {
      const optimized = `export function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}
`;
      await writeFile(hotPath, optimized);
      result.step_done = true;
      result.tests_pass = true;
      result.notes = `Stub executor completed ${stepId}: replaced quadratic unique sort with Set-based implementation.`;
      result.changed_files = ['src/hotpath.js'];
    } else if ((await exists(join(paths.wici, 'stub-two-keeps'))) && !current.includes('wici-stub-v2')) {
      await writeFile(hotPath, `${current.trimEnd()}\n// wici-stub-v2\n`);
      result.step_done = false;
      result.tests_pass = true;
      result.notes = `Stub executor completed ${stepId}: added fixture marker for a second accepted stepping stone.`;
      result.changed_files = ['src/hotpath.js'];
    } else {
      result.step_done = true;
      result.tests_pass = true;
      result.notes = `Stub executor completed ${stepId}: hot path already optimized.`;
      result.changed_files = [];
    }
  }

  await atomicWriteJson(join(paths.artifacts, `iter-${iter}.json`), result);
  return result;
}

export function buildExecutorArgs(input: { iter: number; target: string; artifactPath: string; schemaPath: string; prompt: string }): string[] {
  if (input.iter === 1) {
    return [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '--output-last-message',
      input.artifactPath,
      '--output-schema',
      input.schemaPath,
      '-C',
      input.target,
      '--skip-git-repo-check',
      input.prompt
    ];
  }

  return [
    'exec',
    'resume',
    '--last',
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    '--output-last-message',
    input.artifactPath,
    '--output-schema',
    input.schemaPath,
    '-C',
    input.target,
    '--skip-git-repo-check',
    input.prompt
  ];
}
