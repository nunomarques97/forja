import { join } from 'node:path';

// Maps a request path of the static file server to a file under the public root.
export function resolveInside(root, requestPath) {
  return join(root, decodeURIComponent(requestPath));
}
