// Supervisão mútua: a guarda vigia o viewer, o viewer vigia a guarda
// (docs/ARCHITECTURE.md §12). Node core only.
//
// Porquê. A guarda (lib/guard.mjs) nasceu do incidente de 17 set 2026: o runner
// do Job Hunter morreu e nada o relançou, porque o único vigia — o watchdog
// dentro do viewer — só notifica, e nesse dia nem isso: o próprio viewer tinha
// morrido no mesmo minuto (SIGHUP). A guarda resolve metade do problema (um
// runner morto volta), e deixa a outra metade de pé: um viewer morto continua a
// ser um telemóvel sem notificações e sem botão de "Novo run", até ao próximo
// login. Daí este ficheiro: os dois processos de vida longa passam a olhar um
// para o outro, com AS MESMAS regras e AS MESMAS constantes dos dois lados —
// escritas aqui uma vez só.
//
// Dois processos capazes de se relançarem um ao outro podem oscilar: A acha que
// B morreu e lança um B, B acha que A morreu e lança um A, para sempre. Quatro
// regras impedem-no, e a terceira é a que importa mesmo:
//   1. uma dúvida conta como VIDA, nunca como morte (uma linha de comandos que
//      não se consegue ler é um par vivo: nunca se relança na dúvida);
//   2. o par só é vigiado depois de ter sido visto vivo uma vez (`seen_at`):
//      ninguém relança o que nunca lá esteve;
//   3. a graça de 2 min conta-se SEMPRE a partir do arranque do próprio vigia,
//      nunca de um `dead_since` do disco que lhe seja anterior — é isto que
//      impede um processo acabado de relançar de relançar de volta, no primeiro
//      segundo de vida, quem o relançou a ele;
//   4. teto de 3 tentativas, 15 min entre elas, e o contador só se zera com
//      30 min de saúde OBSERVADA (uma leitura errada nunca produz saúde
//      observada, por isso nunca devolve tentativas a um ciclo doente).
// O ficheiro de paragem de cada lado (`data/up.stop`, `data/guard/guard.stop`)
// ganha a tudo: `forja down` continua a querer dizer "parado", não "parado
// durante dois minutos".
//
// A decisão é uma função pura (`peerPlan`) com o relógio injetado; a camada de
// ação (`runPeerCheckOnce`) tem o spawn e o notify injetáveis e não escreve nada
// em disco — quem chama é que persiste o estado (data/guard/state.json do lado
// da guarda, data/up-watch/state.json do lado do viewer).
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, forjaRoot as defaultForjaRoot, nowIso } from './state-files.mjs';
import { LOCK_STALE_MS, commandLineOf, pidAlive, readLock } from './runner.mjs';
import { launchForja } from './spawn-runner.mjs';
import { notify as defaultNotify } from './notify.mjs';

// ---------- constants (uma definição só, usada pelos dois lados) ----------
export const PEER_DEAD_GRACE_MS = 120_000;   // o par só conta como morto depois disto
export const PEER_RETRY_MS = 900_000;        // espaçamento mínimo entre duas tentativas (= LOCK_STALE_MS)
export const PEER_MAX_ATTEMPTS = 3;          // tentativas (relançamentos + spawns falhados); depois desiste e di-lo, uma vez
export const PEER_HEALTHY_MS = 1_800_000;    // par vivo este tempo seguido, e observado, zera o contador

// ---------- quem é quem ----------
// A linha de comandos de cada par, como a `GUARD_CMD_RE` original: o pid sozinho
// não chega porque o Windows reutiliza pids em minutos.
export const GUARD_CMD_RE = /forja\.mjs["']?\s+guard\b/;
export const UP_CMD_RE = /forja\.mjs["']?\s+up\b/;

// `label` e as três formas que concordam com ele: o viewer é masculino, a
// guarda é feminina, e uma linha que diga «a guarda dos runners morto» é uma
// linha que o Sponsor lê e estranha.
export const PEERS = Object.freeze({
  up: Object.freeze({ label: 'o viewer', dead: 'morto', live: 'vivo', done: 'relançado', stopped: 'parado', args: Object.freeze(['up']), via: 'guard', logDir: 'guard', logName: 'spawn-up' }),
  guard: Object.freeze({ label: 'a guarda dos runners', dead: 'morta', live: 'viva', done: 'relançada', stopped: 'parada', args: Object.freeze(['guard', 'run']), via: 'viewer', logDir: 'up-watch', logName: 'spawn-guard' }),
});
export const peerLabel = peer => (PEERS[peer] ? PEERS[peer].label : 'o par');
const peerWord = (peer, key) => (PEERS[peer] ? PEERS[peer][key] : { dead: 'morto', live: 'vivo', done: 'relançado', stopped: 'parado' }[key]);

// ---------- paths ----------
// Ficheiros que o `up` e o `down` usam para se encontrarem (vinha de lib/up.mjs,
// que o reexporta).
export function controlPaths(data = dataDir()) {
  return { pid: join(data, 'up.pid'), stop: join(data, 'up.stop'), tunnel: join(data, 'tunnel.json') };
}
// Tudo o que a guarda tem é seu vive em data/guard/. data/watchdog.json NÃO é
// nosso: é do watchdog do viewer, que fica exatamente como estava.
export function guardPaths(dir = dataDir()) {
  const base = join(dir, 'guard');
  return { dir: base, lock: join(base, 'guard.lock.json'), stop: join(base, 'guard.stop'), log: join(base, 'guard.log'), state: join(base, 'state.json') };
}
// E o que o viewer tem de seu para esta vigia vive em data/up-watch/ — nome
// diferente de propósito: "watchdog" já é outra coisa, dentro do viewer.
export function upWatchPaths(dir = dataDir()) {
  const base = join(dir, 'up-watch');
  return { dir: base, state: join(base, 'state.json'), log: join(base, 'up-watch.log') };
}

// ---------- liveness ----------
/**
 * Vivo = o pid existe E a linha de comandos ainda é a do par.
 * Uma linha de comandos ILEGÍVEL conta como VIVO: na dúvida nunca se relança
 * nada (é a primeira regra anti-oscilação).
 */
export function peerAlive(pid, re, cmdOf = commandLineOf) {
  if (!pidAlive(pid)) return false;
  const cmd = cmdOf(pid);
  return cmd === null ? true : re.test(cmd);
}

/**
 * A MESMA resposta que `peerAlive`, sem bloquear o event loop — o gémeo de
 * `ownerAliveAsync` (lib/projects.mjs), e pela mesma razão, escrita lá em 2026:
 * a chamada ao PowerShell custa ~300 ms e o viewer também serve SSE. Quem
 * pergunta do lado do viewer é este processo, o mesmo que está a alimentar o
 * telemóvel pelo túnel; 300 ms de event loop parado de 30 em 30 s seriam pagos
 * pela página de quem está a olhar. A guarda, essa, pode continuar a perguntar
 * em síncrono: é um processo dedicado, não serve nada a ninguém.
 * Mesmo default seguro: linha de comandos ilegível = VIVO.
 */
export function peerAliveAsync(pid, re) {
  return new Promise(resolve => {
    if (!pidAlive(pid)) return resolve(false);
    if (process.platform !== 'win32') {
      readFile(`/proc/${Number(pid)}/cmdline`, 'utf8')
        .then(s => resolve(re.test(s.replace(/\0/g, ' ').trim())))
        .catch(() => resolve(true));
      return;
    }
    let done = false; let out = '';
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return finish(true); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(true); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { if (out.length < 8192) out += d; });
    child.on('error', () => { clearTimeout(timer); finish(true); });
    child.on('close', code => { clearTimeout(timer); finish(code === 0 ? re.test(out.trim()) : true); });
  });
}

// Uma entrada por (par, pid): o último valor e quando foi medido. Ao contrário
// do `ownerAliveCached`, aqui NUNCA há um caminho síncrono — quem pergunta já
// está dentro de uma função `async` e pode esperar, e é isso que mantém o event
// loop do viewer livre também na PRIMEIRA vez que vê um pid. O TTL é curto de
// propósito: uma decisão que pode ARRANCAR UM PROCESSO nunca se toma com um
// valor velho (a volta é de 30 s, o TTL de 3 s, por isso na prática mede-se
// sempre; a cache existe para voltas que se cruzem e para quem pergunte duas
// vezes seguidas).
const peerAliveCache = new Map();
export const PEER_ALIVE_TTL_MS = 3000;
const PEER_ALIVE_EVICT_MS = 60_000;
export const resetPeerAliveCache = () => peerAliveCache.clear();
export async function peerAliveCachedAsync(pid, re, { now = Date.now(), aliveAsync = peerAliveAsync } = {}) {
  const key = `${re.source}|${pid}`;
  const hit = peerAliveCache.get(key);
  if (hit && now - hit.at < PEER_ALIVE_TTL_MS) return hit.value;
  const value = await aliveAsync(pid, re);
  peerAliveCache.set(key, { at: Date.now(), value });
  if (peerAliveCache.size > 32) for (const [k, v] of peerAliveCache) if (Date.now() - v.at >= PEER_ALIVE_EVICT_MS) peerAliveCache.delete(k);
  return value;
}

// A primeira linha de data/up.pid. A segunda (a CreationDate que o `up` guarda
// para o `down` o distinguir de um pid reutilizado) é assunto do `down`, do
// `isOurUp` dele — aqui não se toca.
export function readUpPid(dir = dataDir()) {
  try {
    const n = Number(String(readFileSync(controlPaths(dir).pid, 'utf8').split(/\r?\n/)[0]).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}
export function upAlive(dir = dataDir()) {
  const pid = readUpPid(dir);
  return pid === null ? false : peerAlive(pid, UP_CMD_RE);
}

// A guarda, vista de fora: o lock dela com batimento fresco E um pid que ainda é
// uma guarda. Um batimento velho é uma guarda que está pendurada, não viva.
export function guardAlive(pid) {
  return peerAlive(pid, GUARD_CMD_RE);
}
export function guardProcessAlive(dir = dataDir(), now = Date.now()) {
  const pid = guardLockPid(dir, now);
  return pid === null ? false : guardAlive(pid);
}
// A parte barata (ler um JSON de 200 bytes) separada da cara (perguntar ao
// sistema pela linha de comandos), para os dois caminhos — o síncrono da guarda
// e o assíncrono do viewer — decidirem exatamente a mesma coisa sobre o lock.
export function guardLockPid(dir = dataDir(), now = Date.now()) {
  const lock = readLock(guardPaths(dir).lock);
  if (!lock || !lock.pid) return null;
  const beat = Date.parse(lock.beat || lock.since || 0);
  if (!Number.isFinite(beat) || now - beat >= LOCK_STALE_MS) return null;
  return lock.pid;
}
// A versão que o viewer usa: mesma resposta, sem bloquear o event loop.
export async function guardProcessAliveAsync(dir = dataDir(), now = Date.now(), aliveAsync = peerAliveCachedAsync) {
  const pid = guardLockPid(dir, now);
  return pid === null ? false : Boolean(await aliveAsync(pid, GUARD_CMD_RE, { now }));
}

// ---------- entry (o estado por par, igual dos dois lados) ----------
const msOf = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
const isoOf = ms => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
};
const counter = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, PEER_MAX_ATTEMPTS) : 0; };
const minutes = ms => Math.max(0, Math.round(ms / 60_000));
const seconds = ms => Math.max(0, Math.round(ms / 1000));

export const blankPeerEntry = () => ({ attempts: 0, failed_spawns: 0, dead_since: null, last_attempt_at: null, alive_since: null, gave_up_at: null, seen_at: null });

export function readPeerEntry(raw) {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    attempts: counter(e.attempts),
    // Tentativas que nunca chegaram a ser um processo: não gastam uma das três
    // reais, mas contam para o mesmo teto (senão um arranque partido repetia-se
    // para sempre sem ninguém saber). Mesma disciplina da guarda.
    failed_spawns: counter(e.failed_spawns),
    dead_since: msOf(e.dead_since),
    last_attempt_at: msOf(e.last_attempt_at),
    alive_since: msOf(e.alive_since),
    gave_up_at: msOf(e.gave_up_at),
    // Já vi este par vivo alguma vez neste data dir? Enquanto for null, nada é
    // relançado: ninguém ressuscita o que nunca lá esteve.
    seen_at: msOf(e.seen_at),
  };
}
export const writePeerEntry = e => ({
  attempts: e.attempts, failed_spawns: e.failed_spawns || 0,
  dead_since: isoOf(e.dead_since), last_attempt_at: isoOf(e.last_attempt_at),
  alive_since: isoOf(e.alive_since), gave_up_at: isoOf(e.gave_up_at), seen_at: isoOf(e.seen_at),
});
// Quantas tentativas este par já levou: relançamentos reais mais spawns que não
// deram processo. O teto, o "tentativa N de 3" e a desistência contam isto.
export const peerTries = e => (e ? counter(e.attempts) + counter(e.failed_spawns) : 0);

// ---------- mensagens (só estado: nunca um caminho, uma porta ou um token) ----------
export const peerRelaunchMessage = (peer, n, max = PEER_MAX_ATTEMPTS) =>
  `Forja: ${peerLabel(peer)} morreu — relancei (tentativa ${n} de ${max})`;
export const peerGaveUpMessage = (peer, max = PEER_MAX_ATTEMPTS) =>
  `Forja: desisti de relançar ${peerLabel(peer)} — ${max} tentativas seguidas não pegaram; precisa de ti`;

// ---------- decisão pura ----------
/**
 * O que o vigia faria AGORA sobre o seu par. Sem relógio real, sem I/O.
 *
 * `selfStartedAt` é o instante em que o PRÓPRIO vigia começou a vigiar: a graça
 * conta-se sempre a partir dele, e um `dead_since` do disco anterior a esse
 * instante é ignorado. Sem esta regra, um processo acabado de relançar lia o
 * "morto há uma hora" que o disco guardava do par e relançava de volta, no
 * primeiro segundo de vida, quem o tinha relançado a ele.
 *
 * Devolve { act: 'relaunch' | 'give-up' | null, why, entry }, com `entry` já na
 * forma que vai para o disco (datas em ISO). Nenhum contador sobe aqui: quem
 * sobe `attempts`/`failed_spawns` é `runPeerCheckOnce`, depois de saber se o
 * spawn deu mesmo um processo. `gave_up_at` é carimbado aqui, porque desistir é
 * uma decisão (e anuncia-se exatamente uma vez), não um efeito.
 */
export function peerPlan({ peer = 'up', alive = false, stopRequested = false, entry = null, now = Date.now(), selfStartedAt = null } = {}) {
  const clock = Number.isFinite(now) ? now : 0;
  const start = msOf(selfStartedAt);
  const e = readPeerEntry(entry);
  const name = peerLabel(peer);
  const w = key => peerWord(peer, key);
  const done = (act, why) => ({ act, why, entry: writePeerEntry(e) });

  // 1. Parado a pedido (`forja down`, `forja guard stop`, `forja autostart
  //    remove`): o contador vai a zero e NADA é relançado enquanto o ficheiro
  //    existir. `seen_at` fica: já o vi vivo, e um `up` novo apaga o up.stop
  //    sozinho ao arrancar, por isso a vigia recomeça sem cerimónia.
  if (stopRequested) {
    e.attempts = 0; e.failed_spawns = 0; e.dead_since = null; e.last_attempt_at = null; e.alive_since = null; e.gave_up_at = null;
    return done(null, `${name} está ${w('stopped')} a pedido (ficheiro de paragem) — não relanço e o contador fica a zero`);
  }
  // 2. Vivo: limpa o relógio da morte, começa (ou continua) a série de saúde, e
  //    marca que já o vi. 30 min de saúde OBSERVADA zeram o contador — uma
  //    leitura errada («está morto» sobre um par vivo) nunca produz isto, e por
  //    isso nunca devolve tentativas a um ciclo doente.
  if (alive) {
    e.dead_since = null;
    if (e.alive_since === null || e.alive_since > clock) e.alive_since = clock;
    e.seen_at = clock;
    if (clock - e.alive_since >= PEER_HEALTHY_MS && (peerTries(e) > 0 || e.gave_up_at !== null)) {
      e.attempts = 0; e.failed_spawns = 0; e.last_attempt_at = null; e.gave_up_at = null;
      return done(null, `${name} ${w('live')} há ${minutes(clock - e.alive_since)} min — contador a zero`);
    }
    return done(null, `${name} ${w('live')}`);
  }
  e.alive_since = null;
  // 3. Morto, mas nunca o vi vivo: não é meu. Numa máquina onde o par nunca
  //    arrancou (data dir novo, `forja up` nunca corrido) isto não custa
  //    tentativa nenhuma. Atenção ao que NÃO diz: `seen_at` fica no disco para
  //    sempre depois da primeira vez, por isso um `forja serve` corrido à mão
  //    mais tarde — que não escreve `up.pid` e ocupa a porta — conta como
  //    "viewer morto" e custa à guarda as 3 tentativas e a notificação de
  //    desistência (§12, limite conhecido).
  if (e.seen_at === null) return done(null, `nunca vi ${name} ${w('live')} neste data dir — não relanço o que nunca cá esteve`);
  // 4. A regra crítica: a graça conta-se do arranque DESTE vigia. Um dead_since
  //    ausente, no futuro (relógio acertado para trás) ou anterior ao meu
  //    arranque é carimbado de novo, agora.
  if (e.dead_since === null || e.dead_since > clock || (start !== null && e.dead_since < start)) e.dead_since = clock;
  const deadFor = clock - e.dead_since;
  // 5. Dentro da graça: ainda não é uma morte, é uma falta de sinal.
  if (deadFor < PEER_DEAD_GRACE_MS) return done(null, `${name} ${w('dead')} há ${seconds(deadFor)}s — dentro da graça de ${seconds(PEER_DEAD_GRACE_MS)}s`);
  // 6. Espaçamento entre tentativas. Este SIM confia no disco: o espaçamento tem
  //    de sobreviver a um reinício do próprio vigia, ou dois reinícios seguidos
  //    davam duas tentativas em segundos.
  const since = e.last_attempt_at === null ? null : clock - e.last_attempt_at;
  if (since !== null && since < PEER_RETRY_MS) return done(null, `última tentativa há ${minutes(since)} min — espero ${minutes(PEER_RETRY_MS)} min entre tentativas`);
  // 7. Teto: desisto, em voz alta, uma vez só.
  const tries = peerTries(e);
  if (tries >= PEER_MAX_ATTEMPTS) {
    if (e.gave_up_at !== null) return done(null, `já desisti de relançar ${name} (${tries} tentativas)`);
    e.gave_up_at = clock;
    return done('give-up', `desisti de relançar ${name} depois de ${tries} tentativas`);
  }
  // 8. Relançar.
  return done('relaunch', `${name} ${w('dead')} há ${minutes(deadFor)} min — relanço (tentativa ${tries + 1} de ${PEER_MAX_ATTEMPTS})`);
}

// ---------- camada de ação ----------
export const safeNotify = async (notify, message, opts) => {
  try { return await notify(message, opts); } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};
// O mesmo link de sempre (o `ping` da CLI, as notificações da guarda): a vista
// do telemóvel. O `notify` é que lhe limpa a query (sanitizeClick), por isso um
// tunnel.json antigo nunca põe um token no tópico; sem túnel a chave nem vai.
export function phoneUrl(dir = dataDir()) {
  try { const t = JSON.parse(readFileSync(join(dir, 'tunnel.json'), 'utf8')); return t.mobileUrl || t.url || undefined; } catch { return undefined; }
}
export const withClick = (opts, click) => (click ? { ...opts, click } : opts);

const stampOf = ms => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/[:.]/g, '-');
export const peerSpawnLog = (dir, peer, now = Date.now()) => {
  const spec = PEERS[peer];
  return join(dir, spec.logDir, `${spec.logName}-${stampOf(now)}.log`);
};

/**
 * Uma passagem sobre um par: decide, relança, notifica, devolve o estado novo.
 * NÃO escreve nada em disco — quem chama é que persiste (a guarda no seu
 * state.json, o viewer no dele), numa escrita só ao fim da volta.
 * Devolve { entry, act, note, pid }.
 */
export async function runPeerCheckOnce({
  peer,
  dataDir: dir = dataDir(),
  forjaRoot: forja = defaultForjaRoot,
  entry = null,
  now = Date.now(),
  selfStartedAt = now,
  alive = false,
  stopRequested = false,
  spawn = launchForja,
  notify = defaultNotify,
  log = null,
} = {}) {
  const spec = PEERS[peer];
  if (!spec) throw new Error(`par desconhecido: ${String(peer)} (só 'up' ou 'guard')`);
  const plan = peerPlan({ peer, alive, stopRequested, entry, now, selfStartedAt });
  const e = plan.entry;
  const click = phoneUrl(dir);
  let note = plan.why;
  let pid;

  if (plan.act === 'relaunch') {
    const attempt = peerTries(e) + 1;
    let err = null;
    try {
      pid = spawn({
        dataDir: dir, forjaRoot: forja, peer,
        args: [...spec.args],                       // argv fixo, nunca texto vindo de um ficheiro
        logPath: peerSpawnLog(dir, peer, now),
        via: spec.via,
      });
    } catch (e2) { err = String((e2 && e2.message) || e2).slice(0, 120); pid = undefined; }
    if (pid) {
      // Só agora a tentativa conta: um spawn que não deu processo não pode
      // gastar uma das três.
      e.attempts = Math.min((Number(e.attempts) || 0) + 1, PEER_MAX_ATTEMPTS);
      e.last_attempt_at = isoOf(now);
      e.dead_since = null;                          // a graça recomeça a contar a partir do relançamento
      note = `${spec.label}: ${spec.done} (tentativa ${attempt} de ${PEER_MAX_ATTEMPTS}, pid ${pid})`;
      // No phone ntfy here: the relaunch already fixed it — nothing waits on the Sponsor.
    } else {
      // Nada arrancou: a tentativa não é gasta, mas é contada E carimbada — é o
      // carimbo que impede a volta seguinte de pedir o mesmo spawn 30 s depois,
      // para sempre.
      e.failed_spawns = Math.min((Number(e.failed_spawns) || 0) + 1, PEER_MAX_ATTEMPTS);
      e.last_attempt_at = isoOf(now);               // dead_since fica: nada foi relançado
      note = `${spec.label}: relançamento falhou (${err || 'sem pid'}) — tentativa ${attempt} de ${PEER_MAX_ATTEMPTS} não gasta, mas contada`;
    }
  } else if (plan.act === 'give-up') {
    await safeNotify(notify, peerGaveUpMessage(peer, PEER_MAX_ATTEMPTS), withClick({ priority: 'urgent', tags: ['rotating_light'], dedup: false }, click));
  }
  if (typeof log === 'function') log(note);
  return { entry: e, act: plan.act, note, pid };
}

// ---------- ficheiros de estado (o mesmo formato dos dois lados) ----------
export function appendPeerLog(path, line) {
  try { mkdirSync(join(path, '..'), { recursive: true }); appendFileSync(path, `${nowIso()} ${String(line).replace(/[\r\n]+/g, ' ')}\n`); } catch {}
}

// data/up-watch/state.json — { version: 1, guard: {…} }. Ilegível ou corrupto lê
// como vazio, nunca com exceção: o viewer tem de continuar a servir.
export const EMPTY_UP_WATCH_STATE = () => ({ version: 1, guard: {} });
export function readUpWatchState(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return EMPTY_UP_WATCH_STATE(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_UP_WATCH_STATE();
  const ok = raw.guard && typeof raw.guard === 'object' && !Array.isArray(raw.guard);
  return { version: 1, guard: ok ? raw.guard : {} };
}
// tmp+rename, como todas as escrituras de estado do Forja: um crash nunca deixa
// meio ficheiro, e meio ficheiro é um contador perdido.
export function writeUpWatchState(path, state) {
  mkdirSync(join(path, '..'), { recursive: true });
  const body = JSON.stringify({ version: 1, guard: (state && state.guard) || {} }, null, 2) + '\n';
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  return state;
}
