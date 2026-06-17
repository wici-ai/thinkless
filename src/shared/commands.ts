import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { execa } from 'execa';

export interface ResolvedCommand {
  command: string;
  args: string[];
  shell?: boolean;
}

export async function commandExists(command: string): Promise<boolean> {
  const normalized = command.trim();
  if (!normalized) return false;
  if (looksLikePath(normalized)) return Boolean(await resolveExplicitPath(normalized));
  if (process.platform === 'win32') {
    return Boolean(await resolveWindowsPath(normalized));
  }
  const result = await execa('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', normalized], { reject: false });
  return result.exitCode === 0;
}

export async function resolveCommandForSpawn(command: string, args: string[]): Promise<ResolvedCommand> {
  if (process.platform !== 'win32') return { command, args };

  const resolved = looksLikePath(command) ? await resolveExplicitPath(command) : await resolveWindowsPath(command);
  if (!resolved) return { command, args };

  const ext = extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const nodeShim = await resolveNodeCmdShim(resolved);
    if (nodeShim) return { command: process.execPath, args: [nodeShim, ...args] };
    return { command: resolved, args, shell: true };
  }
  return { command: resolved, args };
}

function looksLikePath(command: string): boolean {
  return command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command);
}

async function resolveExplicitPath(path: string): Promise<string | null> {
  if (await fileExists(path)) return path;
  if (process.platform !== 'win32' || extname(path)) return null;
  for (const ext of windowsExecutableExtensions()) {
    const candidate = `${path}${ext}`;
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function resolveWindowsPath(command: string): Promise<string | null> {
  const result = await execa('where.exe', [command], { reject: false });
  if (result.exitCode !== 0) return null;
  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return candidates.find((candidate) => windowsExecutableExtensions().includes(extname(candidate).toLowerCase())) ?? candidates[0] ?? null;
}

function windowsExecutableExtensions(): string[] {
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

async function resolveNodeCmdShim(path: string): Promise<string | null> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  const matches = [...raw.matchAll(/"([^"]+\.js)"/gi)].map((match) => match[1]);
  const script = matches.at(-1);
  if (!script) return null;
  const expanded = expandCmdScriptPath(script, dirname(path));
  return (await fileExists(expanded)) ? expanded : null;
}

function expandCmdScriptPath(path: string, baseDir: string): string {
  const withBase = path
    .replace(/^%~dp0[\\/]?/i, `${baseDir}\\`)
    .replace(/^%dp0%[\\/]?/i, `${baseDir}\\`);
  return isAbsolute(withBase) ? withBase : join(baseDir, withBase);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
