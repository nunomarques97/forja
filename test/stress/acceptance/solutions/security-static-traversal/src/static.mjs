import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { contentType } from './mime.mjs';

// URL path -> absolute file inside root, or null when it points elsewhere or
// cannot be decoded. The check compares path segments, so a sibling folder
// that merely shares the root's prefix ("public-old") is outside.
export function resolveStatic(root, urlPath) {
  const base = resolve(root);
  let path;
  try {
    path = decodeURIComponent(String(urlPath).split('?')[0]);
  } catch {
    return null;
  }
  if (path.includes('\0')) return null;
  if (path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
  const file = join(base, path);
  const rel = relative(base, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return file;
}

export function createStaticHandler(root) {
  return function handle({ method = 'GET', url = '/' }) {
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { allow: 'GET, HEAD' }, body: '' };
    const file = resolveStatic(root, url);
    if (!file) return { status: 404, headers: {}, body: 'not found' };
    try {
      if (!statSync(file).isFile()) return { status: 404, headers: {}, body: 'not found' };
      const body = readFileSync(file);
      return { status: 200, headers: { 'content-type': contentType(file), 'content-length': String(body.length) }, body: method === 'HEAD' ? '' : body };
    } catch {
      return { status: 404, headers: {}, body: 'not found' };
    }
  };
}
