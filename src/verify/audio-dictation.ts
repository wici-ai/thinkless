import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_ROOT } from '../shared/paths.js';
import { appendDictationText, dictationUnavailableMessage, normalizeTranscript, parseDictationRequest, runDictationCommand } from '../tui/dictation.js';

async function main(): Promise<void> {
  assert(parseDictationRequest('/dictate', { WICI_DICTATION_COMMAND: 'printf hello' })?.command === 'printf hello', 'dictation command must come from WICI_DICTATION_COMMAND');
  assert(parseDictationRequest('/dictate submit', { WICI_DICTATION_COMMAND: 'printf hello' })?.submit === true, 'dictation submit mode should be parsed');
  assert(parseDictationRequest('/dictate now', { WICI_DICTATION_COMMAND: 'printf hello' }) === null, 'unknown dictation suffixes should not be treated as commands');
  assert(parseDictationRequest('/dictate', {})?.command === null, 'missing dictation command should be represented explicitly');
  assert(dictationUnavailableMessage().includes('WICI_DICTATION_COMMAND'), 'unavailable message should tell the user how to configure dictation');
  assert(normalizeTranscript(' hello\n  dictated\tworld ') === 'hello dictated world', 'transcripts should be whitespace-normalized');
  assert(appendDictationText('existing text', ' dictated words ') === 'existing text dictated words', 'dictation should append to existing input');
  assert(appendDictationText('', ' dictated words ') === 'dictated words', 'dictation should populate empty input');

  const result = await runDictationCommand('printf "hello from dictation\\n"', { timeoutMs: 5_000 });
  assert(result.text === 'hello from dictation', `unexpected dictation stdout: ${JSON.stringify(result)}`);
  assert(result.wordCount === 3, `unexpected dictation word count: ${JSON.stringify(result)}`);

  const chatPane = await readFile(join(TOOL_ROOT, 'src', 'tui', 'ChatPane.tsx'), 'utf8');
  assert(chatPane.includes('parseDictationRequest') && chatPane.includes('runDictationCommand'), 'ChatPane must wire /dictate into the input flow');
  assert(chatPane.includes('dictation: listening') && chatPane.includes('dictation failed:'), 'ChatPane must report dictation progress and errors');
  assert(chatPane.includes('await submit(next)'), 'ChatPane must support /dictate submit');

  console.log(JSON.stringify({ ok: true, dictation_command: true, dictation_submit: true }, null, 2));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
