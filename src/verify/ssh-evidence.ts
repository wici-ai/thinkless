export interface SshTranscriptEvidence {
  hasSshAttempt: boolean;
  hasExpectedTarget: boolean;
  expectedHostTerms: string[];
}

export function inspectCodexSshTranscript(text: string, expectedText = ''): SshTranscriptEvidence {
  const expectedHostTerms = extractExpectedHostTerms(expectedText);
  const hasExpectedTarget = expectedHostTerms.length === 0 || expectedHostTerms.some((term) => text.includes(term));
  const commandExecutionSsh = /"type":"command_execution"/.test(text) && /"command":"(?:\\.|[^"])*\bssh\b/i.test(text);
  const authFailure = /Permission denied \(publickey\)|Authenticating to [^\s"']+|Offering public key|No more authentication methods to try/i.test(text);
  return {
    hasSshAttempt: hasExpectedTarget && (commandExecutionSsh || authFailure),
    hasExpectedTarget,
    expectedHostTerms
  };
}

function extractExpectedHostTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.matchAll(/\b[A-Za-z0-9._-]+@(?:(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
    terms.add(match[0]);
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    terms.add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    terms.add(match[0]);
  }
  return [...terms].filter((term) => !isProbablyUrlHost(term)).sort();
}

function isProbablyUrlHost(term: string): boolean {
  return ['localhost'].includes(term) || /\.(md|json|txt|sh)$/i.test(term);
}
