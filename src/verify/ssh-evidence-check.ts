import { inspectCodexSshTranscript } from './ssh-evidence.js';

const expected = '听说diffusionGemma很快，在ssh -p 23276 root@116.127.115.18 -L 8080:localhost:8080试试，要求达到700 token/s以上';
const matchingCommand = JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command: "/bin/zsh -lc \"ssh -p 23276 root@116.127.115.18 'echo OK'\"",
    aggregated_output: 'root@116.127.115.18: Permission denied (publickey).'
  }
});
const matchingAuthOutput = [
  'debug1: Authenticating to 116.127.115.18:23276 as root',
  'debug1: Offering public key: /Users/saprk/.ssh/id_ed25519',
  'root@116.127.115.18: Permission denied (publickey).'
].join('\n');
const wrongTarget = JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command: "/bin/zsh -lc \"ssh root@203.0.113.10 'echo OK'\"",
    aggregated_output: 'root@203.0.113.10: Permission denied (publickey).'
  }
});
const noExpectedText = JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command: "/bin/zsh -lc \"ssh root@example.test 'echo OK'\""
  }
});

const match = inspectCodexSshTranscript(matchingCommand, expected);
assert(match.hasSshAttempt, 'matching SSH command should prove a Codex SSH attempt');
assert(match.hasExpectedTarget, 'matching SSH command should include an expected target');
assert(match.expectedHostTerms.includes('root@116.127.115.18') && match.expectedHostTerms.includes('116.127.115.18'), 'expected terms should include user and host');

const auth = inspectCodexSshTranscript(matchingAuthOutput, expected);
assert(auth.hasSshAttempt, 'matching SSH auth failure output should prove a Codex SSH attempt');

const wrong = inspectCodexSshTranscript(wrongTarget, expected);
assert(!wrong.hasSshAttempt, 'SSH command to the wrong host must not prove this canary target');
assert(!wrong.hasExpectedTarget, 'wrong host transcript should not match expected target terms');

const generic = inspectCodexSshTranscript(noExpectedText);
assert(generic.hasSshAttempt, 'without expected target text, an SSH command should count as generic SSH evidence');

const noSsh = inspectCodexSshTranscript('{"type":"item.completed","item":{"type":"message","text":"done"}}', expected);
assert(!noSsh.hasSshAttempt, 'non-command transcript must not prove SSH evidence');

console.log(
  JSON.stringify(
    {
      ok: true,
      target_match: true,
      wrong_target_rejected: true,
      auth_failure_output_supported: true,
      generic_ssh_supported_without_expected_target: true
    },
    null,
    2
  )
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
