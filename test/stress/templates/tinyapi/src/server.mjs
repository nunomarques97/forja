#!/usr/bin/env node
import { createServer } from 'node:http';
import { createHandler } from './handler.mjs';

const handle = createHandler();
const port = Number(process.env.PORT || 8080);

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const result = handle({ method: req.method, path: url.pathname, ip: req.socket.remoteAddress, headers: req.headers });
  res.writeHead(result.status, result.headers);
  res.end(JSON.stringify(result.body));
}).listen(port, '127.0.0.1', () => console.log(`tinyapi on http://127.0.0.1:${port}`));
