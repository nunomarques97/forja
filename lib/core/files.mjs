import { lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export function git(cwd, args, { allowFailure = false } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  });
  if (r.status !== 0 && !allowFailure)
    throw new Error(
      `git ${args[0]} failed: ${(r.stderr || r.error?.message || '').slice(0, 400)}`,
    );
  return r.stdout || '';
}
// links: false checks the path text only, for persisted state that must stay
// readable after a worker replaced a directory with a link. Every read or write
// keeps the default filesystem check.
export function inside(root, path, { links = true } = {}) {
  const abs = resolve(root, path),
    rel = relative(root, abs);
  if (
    rel === '..' ||
    rel.startsWith('..\\') ||
    rel.startsWith('../') ||
    isAbsolute(rel)
  )
    throw new Error(`Path outside project: ${path}`);
  if (!links) return abs;
  let ancestor = abs;
  while (ancestor !== dirname(ancestor)) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  const actual = relative(realpathSync(root), realpathSync(ancestor));
  if (
    actual === '..' ||
    actual.startsWith('../') ||
    actual.startsWith('..\\') ||
    isAbsolute(actual)
  )
    throw new Error(`Symlink/junction outside project: ${path}`);
  return abs;
}
export function repoFiles(root) {
  return [
    ...new Set(
      git(root, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ])
        .split('\0')
        .filter(Boolean),
    ),
  ]
    .filter((p) => !p.startsWith('.forja/'))
    .sort();
}
