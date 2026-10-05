#!/usr/bin/env node
import { createServer } from 'node:http';
import { createStaticHandler } from './static.mjs';

const handle = createStaticHandler(process.argv[2] || 'public');
const port = Number(process.env.PORT || 8081);

createServer((req, res) => {
  const result = handle({ method: req.method, url: req.url });
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}).listen(port, '127.0.0.1', () => console.log(`filedrop on http://127.0.0.1:${port}`));
