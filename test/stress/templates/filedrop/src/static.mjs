import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contentType } from './mime.mjs';

// URL path -> absolute file inside root, or null when it points elsewhere.
export function resolveStatic(root, urlPath) {
  const base = resolve(root);
  let path = decodeURIComponent(String(urlPath).split('?')[0]);
  if (path.endsWith('/')) path += 'index.html';
  const file = join(base, path);
  return file.startsWith(base) ? file : null;
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
