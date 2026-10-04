// Shared locations and small file helpers for the long-lived Forja processes
// (guard, `forja up`, the viewer and the project registry). Node core only.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic as writeAtomic } from './atomic-write.mjs';

export const forjaRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const dataDir = () => process.env.FORJA_DATA_DIR || join(forjaRoot, 'data');

export function projectKey(cwd) {
  return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function nowIso() { return new Date().toISOString(); }

// tmp + rename: the guard and the viewer read these files while another
// process writes them. The bounded Windows rename retry lives in
// lib/atomic-write.mjs, which Core uses too; this keeps its per-process tmp name.
const writeFileAtomic = (path, body) => writeAtomic(path, body, { tmp: `${path}.${process.pid}.tmp` });
export function writeJson(path, value) {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}
