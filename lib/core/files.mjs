import { lstatSync, realpathSync, existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export function git(cwd, args, { allowFailure = false } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Controller reads must not refresh and rewrite the user's index.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
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
  let real;
  try {
    real = realpathSync(ancestor);
  } catch (error) {
    // A link whose target is missing: refuse without the absolute local path.
    if (error.code === 'ENOENT') throw new Error(`Dangling symlink/junction: ${path}`);
    throw error;
  }
  const actual = relative(realpathSync(root), real);
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

// Keeps FORJA's private run state out of `git status` on this machine only:
// the rule goes to .git/info/exclude, never to the project's .gitignore.
export function excludeStateDirectory(root) {
  if (spawnSync('git', ['check-ignore', '-q', '.forja/state'], { cwd: root, windowsHide: true, timeout: 30000 }).status === 0) return false;
  const exclude = resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).trim());
  mkdirSync(dirname(exclude), { recursive: true });
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  appendFileSync(exclude, (text && !text.endsWith('\n') ? '\n' : '') + '.forja/\n');
  return true;
}
