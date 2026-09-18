// `forja serve` and `forja token rotate` (docs/ARCHITECTURE.md §11).
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dataDir } from './state-files.mjs';
import { startServer } from '../viewer/server.mjs';

export async function serve({ opt = {} } = {}) {
  const s = startServer({ port: opt.port, host: opt.host });
  await new Promise(() => {}); // runs until SIGINT
  return s;
}

export async function token({ pos = [] } = {}) {
  const path = join(dataDir(), 'viewer-token.txt');
  if (pos[0] === 'rotate') {
    mkdirSync(dataDir(), { recursive: true });
    const t = randomBytes(24).toString('hex');
    writeFileSync(path, t + '\n');
    console.log(JSON.stringify({ ok: true, rotated: true, note: 'reinicia `forja up` (ou o viewer) para o token novo valer; a URL antiga deixa de abrir' }));
    return;
  }
  // `forja token` diz ONDE está o token, nunca o imprime: a saída dos comandos
  // corridos numa sessão do Claude Code é capturada pelo hook para
  // data/events.jsonl, e um token impresso ficaria lá em claro (T-SEC-1). Quem
  // precisa dele abre o ficheiro; quem suspeita de fuga corre `token rotate`.
  try {
    readFileSync(path, 'utf8');
    console.log(JSON.stringify({ ok: true, path, note: 'abre o ficheiro para copiar o token; `forja token rotate` gera outro' }));
  } catch { console.log(JSON.stringify({ ok: false, error: 'sem token ainda — arranca o viewer uma vez' })); }
}
