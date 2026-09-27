import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultsDir = join(root, 'data', 'defaults');

/** Seed shipped with the repo. Not the live database. */
export function bundledFile(name) {
  return join(defaultsDir, name);
}

/**
 * Live JSON path. Never overwrites a file that already exists.
 * With DATA_DIR, that file stays on the mounted volume across deploys.
 * Without it, the live file is data/<name> and is not part of git.
 */
export function dataFile(name) {
  const dir = String(process.env.DATA_DIR ?? '').trim() || join(root, 'data');
  mkdirSync(dir, { recursive: true });
  const live = join(dir, name);
  const bundled = bundledFile(name);
  if (!existsSync(live) && existsSync(bundled)) {
    copyFileSync(bundled, live);
    console.log(`[DATA] Copié ${name} inicial a ${live}`);
  }
  return live;
}
