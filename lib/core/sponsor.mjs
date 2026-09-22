import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notify, sanitizeClick, repoRoot } from '../notify.mjs';

export async function technologyNotice() {
  let click;
  try {
    const data = process.env.FORJA_DATA_DIR || join(repoRoot, 'data');
    const mobile = sanitizeClick(JSON.parse(readFileSync(join(data, 'tunnel.json'), 'utf8')).mobileUrl);
    if (mobile) click = new URL('/core', mobile).toString();
  } catch {}
  return notify('FORJA: uma escolha de tecnologia com custo pago ou por esclarecer precisa da tua decisão. O trabalho está parado.',
    { title: 'FORJA · Decisão necessária', priority: 'high', tags: ['question'], click, dedup: false, timeoutMs: 5000 });
}
