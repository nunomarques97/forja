import { extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.zip': 'application/zip',
};

export const contentType = file => TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
