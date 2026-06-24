#!/usr/bin/env node
import { chmod, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const bins = pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin) : [];

await Promise.all(bins.map((bin) => chmod(resolve(String(bin)), 0o755)));
