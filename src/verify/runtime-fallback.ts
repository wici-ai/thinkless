import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { execa } from 'execa';
import { loadConfig } from '../shared/config.js';
import { defaultRuntimeSelection, formatRuntimeSelection, parseRuntimeCommand } from '../tui/runtimeSettings.js';
import { buildCodexPlannerArgs } from '../supervisor/planner.js';
import { runPaths } from '../shared/paths.js';
import { runChatTurn } from '../supervisor/chatAgent.js';

const target = resolve('fixture/runtime-fallback-target');
const fakeBin = resolve('fixture/runtime-fallback-bin');

async function main(): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFakeCodex();

  const config = await loadConfig('auto');
  assert(config.tools.planner.command === 'codex', `planner should default to codex: ${JSON.stringify(config.tools.planner)}`);
  assert(config.tools.planner.model === 'gpt-5.5', `planner should use Codex model: ${JSON.stringify(config.tools.planner)}`);
  assert(config.tools.planner.effort === 'xhigh', `planner should default to xhigh: ${JSON.stringify(config.tools.planner)}`);
  assert(config.tools.chat?.command === 'claude', `chat should remain Claude-first: ${JSON.stringify(config.tools.chat)}`);
  assert(config.tools.chat?.effort === 'high', `chat Claude default should remain high: ${JSON.stringify(config.tools.chat)}`);

  const selection = defaultRuntimeSelection();
  assert(formatRuntimeSelection(selection, 'planner').includes('agent=codex model=gpt-5.5 effort=xhigh'), 'TUI planner default should be Codex xhigh');
  const selectedCodexPlanner = parseRuntimeCommand('/agent plan codex', selection)?.next;
  assert(selectedCodexPlanner && formatRuntimeSelection(selectedCodexPlanner, 'planner').includes('effort=xhigh'), 'Selecting Codex planner should use xhigh by default');

  const codexPlannerArgs = buildCodexPlannerArgs({
    target,
    prompt: 'plan',
    outputLastMessage: '.thinkless/artifacts/planner-codex.md',
    model: 'gpt-5.5',
    effort: 'xhigh'
  });
  assert(codexPlannerArgs[0] === 'exec', 'Codex planner should use codex exec');
  assert(codexPlannerArgs[codexPlannerArgs.indexOf('--model') + 1] === 'gpt-5.5', 'Codex planner must receive gpt-5.5');
  assert(codexPlannerArgs.includes('model_reasoning_effort="xhigh"'), 'Codex planner must receive xhigh effort');
  assert(codexPlannerArgs.at(-1) === '-' && codexPlannerArgs.stdin === 'plan', 'Codex planner must pass prompt over stdin');

  const paths = runPaths(target);
  const result = await runChatTurn({
    paths,
    userText: 'summarize status',
    goalDoc: '# GOAL\n\nnone',
    plan: '# PLAN\n\nnone',
    recentEvents: [],
    mode: 'auto',
    runtime: { chat: { agent: 'claude' } },
    writeUpdate: false
  });
  assert(!result.degraded, `Chat should auto-fallback to Codex instead of local degraded fallback: ${JSON.stringify(result)}`);
  assert(result.reply.includes('codex fallback reply'), `unexpected Codex fallback reply: ${result.reply}`);

  const argsLog = (await readFile(join(target, '.thinkless', 'fake-codex-chat-args.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  assert(argsLog[0]?.args.includes('--model') && argsLog[0].args[argsLog[0].args.indexOf('--model') + 1] === 'gpt-5.5', 'Chat fallback must use Codex model');
  assert(argsLog[0]?.args.includes('model_reasoning_effort="medium"'), 'Chat fallback must use Codex medium effort');
  assert(argsLog[0]?.args.at(-1) === '-' && argsLog[0].prompt.includes('summarize status'), 'Chat fallback must pass Codex prompt over stdin');

  console.log(JSON.stringify({ ok: true, planner: 'codex-xhigh', chat_fallback: 'codex-medium' }, null, 2));
}

async function writeFakeCodex(): Promise<void> {
  const script = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const prompt = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
});
const target = '${target.replace(/\\/g, '\\\\')}';
const state = join(target, '.thinkless');
mkdirSync(join(state, 'artifacts'), { recursive: true });
appendFileSync(join(state, 'fake-codex-chat-args.jsonl'), JSON.stringify({ args, prompt }) + '\\n');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) {
  writeFileSync(args[outputIndex + 1], '## REPLY\\n\\ncodex fallback reply\\n');
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-chat-fallback-session' }));
console.log(JSON.stringify({ type: 'agentMessage', text: '## REPLY\\n\\ncodex fallback reply\\n' }));
`;
  if (process.platform === 'win32') {
    await writeFile(join(fakeBin, 'codex.js'), script);
    await writeFile(join(fakeBin, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex.js" %*\r\n');
    return;
  }
  const path = join(fakeBin, 'codex');
  await writeFile(path, script);
  await chmod(path, 0o755);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;

try {
  await main();
} finally {
  await rm(target, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
}
