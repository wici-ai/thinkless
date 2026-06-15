import { readFile, stat } from 'node:fs/promises';

export interface SecretFinding {
  path: string;
  pattern: string;
  line: number;
}

export const secretMaxBytes = 2_000_000;

export const secretPatterns = [
  {
    name: 'provider secret token',
    pattern: new RegExp(`\\b${'s'}${'k'}-[A-Za-z0-9_-]{32,}\\b`)
  },
  {
    name: 'anthropic auth env assignment',
    pattern: new RegExp(`${'ANTHROPIC'}_${'AUTH'}_${'TOKEN'}\\s*=\\s*['"]?[^\\s'"]{12,}`, 'i')
  },
  {
    name: 'openai api key env assignment',
    pattern: new RegExp(`${'OPENAI'}_${'API'}_${'KEY'}\\s*=\\s*['"]?[^\\s'"]{12,}`, 'i')
  },
  {
    name: 'private key material',
    pattern: new RegExp(`-{5}BEGIN (?:OPENSSH|RSA|DSA|EC|PRIVATE) PRIVATE KEY-{5}`)
  },
  {
    name: 'bearer token literal',
    pattern: new RegExp(`\\b${'Bearer'}\\s+[A-Za-z0-9._-]{24,}\\b`)
  }
];

export async function scanFilesForSecrets(paths: string[]): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const path of paths) {
    findings.push(...(await scanFileForSecrets(path)));
  }
  return findings;
}

export async function scanFileForSecrets(path: string): Promise<SecretFinding[]> {
  const info = await stat(path);
  if (!info.isFile() || info.size > secretMaxBytes) return [];
  const raw = await readFile(path);
  if (raw.includes(0)) return [];
  const text = raw.toString('utf8');
  if (text.includes('\uFFFD')) return [];
  const findings: SecretFinding[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const item of secretPatterns) {
      if (item.pattern.test(line)) {
        findings.push({ path, pattern: item.name, line: index + 1 });
      }
    }
  }
  return findings;
}
