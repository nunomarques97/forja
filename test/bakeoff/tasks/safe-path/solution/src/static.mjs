import { isAbsolute, relative, resolve } from 'node:path';

const outside = () => Object.assign(new Error('Path is outside the public root'), { code: 'EOUTSIDE' });

// Maps a request path of the static file server to a file under the public root.
export function resolveInside(root, requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { throw outside(); }
  const base = resolve(root);
  // Every request is relative to the root, whatever its separators or prefix.
  const target = resolve(base, './' + decoded.replace(/\\/g, '/').replace(/^\/+/, ''));
  const rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw outside();
  return target;
}
