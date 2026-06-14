import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function atomicWriteFile(path: string, content: string, mode?: number): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, mode === undefined ? undefined : { mode });
  await rename(tmp, path);
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

export async function readJsonFileMaybe<T>(path: string): Promise<T | null> {
  if (!(await exists(path))) return null;
  return readJsonFile<T>(path);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  if (!(await exists(path))) return [];
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function lineCount(path: string): Promise<number> {
  if (!(await exists(path))) return 0;
  const raw = await readFile(path, 'utf8');
  if (raw.length === 0) return 0;
  return raw.endsWith('\n') ? raw.split('\n').length - 1 : raw.split('\n').length;
}

export async function truncateJsonLines(path: string, count: number): Promise<void> {
  if (!(await exists(path))) return;
  const raw = await readFile(path, 'utf8');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, Math.max(0, count));
  await atomicWriteFile(path, lines.length > 0 ? `${lines.join('\n')}\n` : '');
}

export async function removeIfExists(path: string): Promise<void> {
  if (await exists(path)) await rm(path, { recursive: true, force: true });
}

export async function makeReadOnly(path: string): Promise<void> {
  const info = await stat(path);
  await chmod(path, info.mode & ~0o222);
}

export async function makeWritable(path: string): Promise<void> {
  const info = await stat(path);
  await chmod(path, info.mode | 0o200);
}

export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await ensureDir(dirname(path));
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (await isStalePidLock(path)) {
        await rm(path, { force: true });
        handle = await open(path, 'wx');
      } else {
        throw new Error(`WiCi run lock already exists: ${path}`);
      }
    } else {
      throw error;
    }
  }
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close();
    await rm(path, { force: true });
  };
}

async function isStalePidLock(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf8');
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ESRCH';
    }
  } catch {
    return true;
  }
}
