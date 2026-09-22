import { lstatSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inside } from './files.mjs';

const MAX_FILES = 100;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export function protectedFileNames(config) {
  if (config.protectedFiles === undefined) return [];
  const paths = config.protectedFiles;
  if (!Array.isArray(paths) || paths.length > MAX_FILES)
    throw new Error(`protectedFiles must contain at most ${MAX_FILES} relative file paths.`);
  const names = Array.from(paths, path => {
    if (typeof path !== 'string' || !path.trim() || path.length > 500 || /[\x00-\x1f:]/.test(path))
      throw new Error('Invalid protectedFiles path.');
    const name = path.replaceAll('\\', '/');
    const parts = name.split('/');
    if (parts.some(part => !part || /[. ]$/.test(part)) || /^(\.git|\.forja)$/i.test(parts[0]))
      throw new Error('protectedFiles requires portable project-relative paths outside scheduler/Git state.');
    return name;
  });
  // Case-insensitive duplicates are rejected for portable Windows/Linux configs.
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length)
    throw new Error('Duplicate protectedFiles paths.');
  return names;
}

function hashes(root, names) {
  let total = 0;
  return names.map(path => {
    let fd;
    try {
      const file = inside(root, path);
      let ancestor = root;
      for (const part of path.split('/')) {
        ancestor = join(ancestor, part);
        if (lstatSync(ancestor).isSymbolicLink()) throw new Error('symbolic links are not supported');
      }
      if (!lstatSync(file).isFile()) throw new Error('expected an existing regular file');
      fd = openSync(file, 'r');
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > MAX_FILE_BYTES || total + before.size > MAX_TOTAL_BYTES)
        throw new Error('file size limit exceeded (8 MiB/file, 16 MiB total)');
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let bytes = 0, count;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
        bytes += count;
        if (bytes > MAX_FILE_BYTES || total + bytes > MAX_TOTAL_BYTES) throw new Error('file size limit exceeded');
        hash.update(buffer.subarray(0, count));
      }
      const after = fstatSync(fd);
      if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        throw new Error('file changed while being read');
      total += bytes;
      return { path, sha256: hash.digest('hex') };
    } catch {
      // Keep the path actionable without copying OS error details or file contents.
      throw new Error(`Protected file unavailable or invalid: ${path}. Restore the original file before resuming.`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  });
}

export function captureProtectedFiles(root, config) {
  const names = protectedFileNames(config);
  if (config.protectedFiles === undefined) return {};
  return { protectedFilesPolicy: 1, protectedFiles: hashes(root, names) };
}

export function validateProtectedFiles(run) {
  const names = protectedFileNames(run.config);
  if (run.config.protectedFiles === undefined && run.protectedFilesPolicy === undefined && run.protectedFiles === undefined) return;
  if (run.config.protectedFiles === undefined || run.protectedFilesPolicy !== 1 || !Array.isArray(run.protectedFiles) || run.protectedFiles.length !== names.length ||
      Array.from(run.protectedFiles).some((entry, i) => !entry || entry.path !== names[i] || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)))
    throw new Error('Invalid protectedFiles manifest; never regenerate acceptance baselines when resuming.');
}

export function assertProtectedFiles(root, run) {
  validateProtectedFiles(run);
  if (!run.protectedFiles?.length) return;
  const actual = hashes(root, run.protectedFiles.map(entry => entry.path));
  for (let i = 0; i < actual.length; i++) {
    if (actual[i].sha256 !== run.protectedFiles[i].sha256)
      throw new Error(`Protected file changed: ${actual[i].path}. Changes preserved; restore the original file before resuming, or abandon and start a new run with the revised acceptance contract.`);
  }
}
