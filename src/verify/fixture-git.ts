import { appendFile } from 'node:fs/promises';

export async function ignoreFixturePlannerOpt(target: string): Promise<void> {
  await appendFile(`${target}/.git/info/exclude`, '\n.opt/\n');
}
