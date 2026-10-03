// Atomic file replacement shared by Core state and the legacy state files.
// Readers (guard, up, viewer, catalogue) open these files while a writer
// replaces them, and a plain writeFileSync could hand them half a file. The
// writer therefore writes a tmp file and renames it over the target. On Windows
// a rename over a file another process has open for reading fails with
// EPERM/EBUSY/EACCES for a few milliseconds: retried briefly. If replacement
// still fails, the tmp file is removed, the previous complete file is kept and
// the error reaches the caller. The target is never truncated as a fallback.
// Node core only, no other Forja imports.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RENAME_RETRIES = 20;
export const RETRYABLE_RENAME_CODES = Object.freeze(['EPERM', 'EBUSY', 'EACCES']);
const pauseMs = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

// Renames tmp over path with the bounded retry; removes tmp when it gives up.
export function replaceFile(tmp, path) {
  for (let i = 0; ; i++) {
    try { renameSync(tmp, path); return; } catch (err) {
      if (!RETRYABLE_RENAME_CODES.includes(err && err.code) || i >= RENAME_RETRIES) {
        try { unlinkSync(tmp); } catch {}
        throw err;
      }
      pauseMs(10);
    }
  }
}

// Without options.tmp the tmp name is unique per call and created with flag wx,
// so concurrent writers in one process never share or overwrite a tmp file.
export function writeFileAtomic(path, body, { tmp } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const file = tmp || `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(file, body, tmp ? undefined : { flag: 'wx' });
  replaceFile(file, path);
}
