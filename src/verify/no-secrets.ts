import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scanFilesForSecrets, secretPatterns } from './secret-scan.js';

const excludedDirs = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo']);
const excludedFiles = new Set(['src/verify/no-secrets.ts']);

async function main(): Promise<void> {
  const files = await listFiles('.');
  const findings = await scanFilesForSecrets(files);

  if (findings.length > 0) {
    throw new Error(`Potential committed secret material found:\n${findings.map((item) => `${item.path}:${item.line} ${item.pattern}`).join('\n')}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        files_scanned: files.length,
        secret_patterns: secretPatterns.length
      },
      null,
      2
    )
  );
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    const normalized = path.replace(/^\.\//, '');
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) continue;
      files.push(...(await listFiles(path)));
      continue;
    }
    if (entry.isFile() && !excludedFiles.has(normalized)) {
      files.push(normalized);
    }
  }
  return files.sort();
}

await main();
