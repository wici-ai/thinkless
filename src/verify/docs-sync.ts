import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const [packageRaw, readme, plan] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('README.md', 'utf8'),
    readFile('PLAN.md', 'utf8')
  ]);
  const pkg = JSON.parse(packageRaw) as { scripts: Record<string, string> };
  const packageVerifyScripts = Object.keys(pkg.scripts)
    .filter((name) => name.startsWith('verify:'))
    .sort();
  const readmeVerifyScripts = [...new Set([...readme.matchAll(/npm run (verify:[a-z0-9:-]+)/g)].map((match) => match[1]))].sort();

  const missingFromReadme = packageVerifyScripts.filter((script) => !readmeVerifyScripts.includes(script));
  const extraInReadme = readmeVerifyScripts.filter((script) => !packageVerifyScripts.includes(script));
  assert(missingFromReadme.length === 0, `README command list missing package verify scripts: ${missingFromReadme.join(', ')}`);
  assert(extraInReadme.length === 0, `README command list has unknown verify scripts: ${extraInReadme.join(', ')}`);

  const openItems = plan.slice(plan.indexOf('## Open items'));
  assert(openItems.includes('verified by `npm run verify:tool-commands`'), 'PLAN open items should record verified Codex resume flags');
  assert(openItems.includes('`npm run verify:executor-contract`'), 'PLAN open items should record the executor contract canary');
  assert(openItems.includes('covered by `npm run verify:outbox`, `npm run verify:clarify`, `npm run verify:manual-lock`, and `npm run verify:ask-stop`'), 'PLAN open items should record implemented two-way intake');
  assert(!openItems.includes('does not advertise `--json`/`--output-schema`'), 'PLAN open items still contain stale Codex resume help assumption');
  assert(!openItems.includes('M1 ships fire-and-forget injection'), 'PLAN open items still describe chat intake as fire-and-forget only');

  console.log(
    JSON.stringify(
      {
        ok: true,
        readme_verify_scripts: readmeVerifyScripts.length,
        package_verify_scripts: packageVerifyScripts.length,
        plan_open_items_current: true
      },
      null,
      2
    )
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
