import { execa } from 'execa';

async function main(): Promise<void> {
  const tag = process.argv[2]?.trim();
  if (!tag || tag === '--help' || tag === '-h') {
    console.error('Usage: npm run release:tag -- <semver-tag>');
    process.exitCode = tag ? 0 : 2;
    return;
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Release tag must be semver-like, got: ${tag}`);
  }
  const existing = await execa('git', ['tag', '--list', tag], { all: true });
  if ((existing.all ?? existing.stdout).trim() === tag) {
    throw new Error(`Release tag already exists locally: ${tag}`);
  }

  try {
    await execa('npm', ['run', 'release:preflight'], { stdio: 'inherit' });
  } catch {
    console.error(`release:tag blocked: release:preflight failed; no tag created for ${tag}.`);
    process.exitCode = 1;
    return;
  }
  await execa('git', ['tag', '-a', tag, '-m', `Release ${tag}`], { stdio: 'inherit' });
  console.log(JSON.stringify({ ok: true, tag, pushed: false }, null, 2));
}

await main();
