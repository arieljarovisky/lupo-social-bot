import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/** Live JSON path. With DATA_DIR, files stay on the mounted volume across deploys. */
export function dataFile(name) {
  const dir = String(process.env.DATA_DIR ?? '').trim();
  if (!dir) return join(bundledDir, name);
  mkdirSync(dir, { recursive: true });
  const live = join(dir, name);
  const bundled = join(bundledDir, name);
  if (!existsSync(live) && existsSync(bundled)) {
    copyFileSync(bundled, live);
    console.log(`[DATA] Copié ${name} inicial a ${live}`);
  }
  return live;
}
