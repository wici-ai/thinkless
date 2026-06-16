import { appendFile, mkdir } from 'node:fs/promises';
import { runPaths } from '../shared/paths.js';

export async function appendSupervisorError(target: string, error: unknown): Promise<void> {
  const paths = runPaths(target);
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  await mkdir(paths.wici, { recursive: true });
  await appendFile(paths.supervisorLog, `[${new Date().toISOString()}] ${detail}\n\n`, 'utf8');
}
