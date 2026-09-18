// `autonomy` of a run — docs/ARCHITECTURE.md §6b.
//
// How much the crew may decide without the Sponsor. Two values:
//   `normal` — today's behaviour: a new dependency (even a free one), a design
//              direction and any product choice reserved to the Sponsor go to
//              the queue with a default applied (`forja ask`), and nothing is
//              installed without him (the Sponsor's global rule).
//   `total`  — the Sponsor said "liberdade total" (17 set 2026, 05:10, after
//              eight queue entries in the first hour of two runs, several of
//              them "confirmar dependência X (gratuita, sem conta)"): those
//              classes are decided inside the run and recorded in DECISIONS.md
//              as "decidido em autonomia total", never queued.
//              The queue keeps exactly what is his to spend or to sign
//              (rule of 17 set 2026, 05:55): **his money** — and, for safety,
//              accounts in his name, sending anything to a third party,
//              deleting data, publishing/pushing. That list is `QUEUE_ALWAYS`
//              below and it is the reason `total` is not "do whatever you want".
//              A money question is queued with the default "não gasto;
//              alternativa gratuita" (`MONEY_DEFAULT`) and the run carries on;
//              if it is still unanswered when the run closes it is copied to
//              the project's `docs/forja/SPONSOR-ROADMAP.md` and listed in the
//              close report under `REPORT_SECTION` — that is where the Sponsor
//              answers money questions, at the end, once (`roadmapRule`).
//
// The autonomy lives in the run's state (`RUN.json.autonomy`, default from the
// project's `docs/forja/SETTINGS.json`, next to `forjalvl`), never in the agent
// files: the same crew runs freer or stricter without editing .claude/agents/*.
//
// Every sentence a prompt, a skill, the CLI or the docs say about this is built
// from here (`autonomyRule`, `queueAlwaysLine`), so the list of what still needs
// the Sponsor has exactly one source in code.
//
// Node core only; no I/O.

export const AUTONOMIES = Object.freeze(['normal', 'total']);
export const AUTONOMY_LABEL = Object.freeze({ normal: 'normal', total: 'total' });

// Accepted on the CLI and in SETTINGS.json. `normal` and `total` read the same
// in Portuguese and in English; `completa` and `full` are the two words a person
// is most likely to type for `total`.
const ALIASES = Object.freeze({
  normal: 'normal',
  total: 'total', completa: 'total', full: 'total',
});

// Empty/missing means "the default autonomy" (normal — the Sponsor's global
// rule until he says otherwise for this project); anything else unknown throws,
// so a typo on the CLI or in SETTINGS.json is refused instead of silently
// running a whole run freer than the Sponsor meant.
export function normalizeAutonomy(x) {
  if (x === undefined || x === null || x === '') return 'normal';
  const k = String(x).trim().toLowerCase();
  // `Object.hasOwn`, never a plain lookup: "constructor", "__proto__" and the
  // rest of Object.prototype must be unknown names, not silent matches.
  if (Object.hasOwn(ALIASES, k)) return ALIASES[k];
  throw new Error(`autonomia desconhecida: "${String(x)}" — usa normal|total`);
}

// The autonomy stored in a state file (RUN.json, SETTINGS.json). `undefined`
// when the key is not there, so the caller can tell "not set" from "set to
// something". A file written before this feature has no key at all and reads as
// the default, which is what those runs actually did.
export function readAutonomy(o) {
  if (!o || typeof o !== 'object') return undefined;
  return o.autonomy;
}

// Reading an autonomy already on disk (RUN.json) never throws: a corrupted value
// must not brick every `forja` command mid-run — it reads as the default, which
// is the *stricter* of the two (a corrupted file never grants freedom).
// Input from a person (CLI flag, SETTINGS.json) goes through normalizeAutonomy,
// which refuses it loudly before the run starts.
export const autonomyOf = value => { try { return normalizeAutonomy(value); } catch { return 'normal'; } };
export const autonomyLabelOf = value => AUTONOMY_LABEL[autonomyOf(value)];
export const isTotal = value => autonomyOf(value) === 'total';

// ---------- what still needs the Sponsor, at every autonomy ----------
//
// The Sponsor's rule of 17 set 2026, 05:55: the queue is for **his money**
// first; the other four are there because they commit him to someone else or
// cannot be undone. Nothing else belongs in the queue at `total`.
// One entry per class, in both languages the repo writes in (the runner's
// prompts and the skills are English, the CLI and the docs are Portuguese for
// the Sponsor). Two languages, one list: a class added here appears in both.
export const QUEUE_ALWAYS = Object.freeze([
  Object.freeze({ pt: 'dinheiro dele (compras, licenças, subscrições, certificados pagos)', en: 'his money (purchases, licences, subscriptions, paid certificates)' }),
  Object.freeze({ pt: 'criar contas em nome dele', en: 'creating accounts in his name' }),
  Object.freeze({ pt: 'enviar seja o que for a terceiros', en: 'sending anything at all to a third party' }),
  Object.freeze({ pt: 'apagar dados', en: 'deleting data' }),
  Object.freeze({ pt: 'publicar, fazer deploy ou push', en: 'publishing, deploying or pushing' }),
]);

// ---------- money questions: default, roadmap, report ----------
// A money question never stops the run and never gets a "maybe": the default is
// always the free path, so the worst case of an unanswered question is a
// cheaper product, never a charge.
// `en` is deliberately the Portuguese sentence, not a translation: this is the
// literal text that goes into `forja ask --default` and from there into
// SPONSOR-QUEUE.md, which the Sponsor reads. The English prompts quote his
// words verbatim so that what an agent is told to type and what he ends up
// reading are the same string, in his language.
export const MONEY_DEFAULT = Object.freeze({ pt: 'não gasto; alternativa gratuita', en: 'não gasto; alternativa gratuita' });
// Where an unanswered money question goes when the run closes, and the section
// of the close report where the Sponsor finds it. The path is inside the
// PROJECT (like everything else in docs/forja/), never inside Forja.
export const ROADMAP_PATH = 'docs/forja/SPONSOR-ROADMAP.md';
export const REPORT_SECTION = 'Para decidires agora que estás aqui';
// The four fields of a roadmap entry, in order.
export const ROADMAP_FIELDS = Object.freeze([
  Object.freeze({ pt: 'título', en: 'title' }),
  Object.freeze({ pt: 'o que se perde por não gastar', en: 'what is lost by not spending' }),
  Object.freeze({ pt: 'custo estimado', en: 'estimated cost' }),
  Object.freeze({ pt: 'data', en: 'date' }),
]);

const LANGS = Object.freeze(['pt', 'en']);
const lang = x => (LANGS.includes(String(x)) ? String(x) : 'pt');
// "A, B e C" / "A, B and C".
const enumerate = (xs, l) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${l === 'pt' ? 'e' : 'and'} ${xs.at(-1)}`);

// The one line `forja autonomy set total` prints and the prompts end on.
export function queueAlwaysLine(l = 'pt') {
  const x = lang(l);
  const list = enumerate(QUEUE_ALWAYS.map(c => c[x]), x);
  return x === 'pt'
    ? `Mesmo em autonomia total continuam a ir à fila do Sponsor: ${list}.`
    : `These still go to the Sponsor queue at every autonomy, total included: ${list}.`;
}

// What happens to a money question: the default, and where it ends up if the
// Sponsor never answers it. One sentence, one source — the runner's CLOSE
// prompt, the skills, `forja autonomy set total` and the docs all print this.
export function roadmapRule(l = 'pt') {
  const x = lang(l);
  const fields = enumerate(ROADMAP_FIELDS.map(f => f[x]), x);
  return x === 'pt'
    ? `Uma pergunta de dinheiro leva sempre o default «${MONEY_DEFAULT.pt}» e o run segue; se ficar sem resposta até ao fecho, é copiada para o ${ROADMAP_PATH} do projeto (cria o ficheiro se faltar; ${fields}) e o relatório de fecho abre uma secção «${REPORT_SECTION}» com essas perguntas — é aí que o Sponsor as decide, no fim e de uma vez.`
    : `A money question always carries the default "${MONEY_DEFAULT.en}" and the run carries on; if it is still unanswered when the run closes, copy it to the project's ${ROADMAP_PATH} (create the file if missing; ${fields}) and give the close report a section "${REPORT_SECTION}" listing those questions — that is where the Sponsor decides them, at the end and in one go.`;
}

// The rule in words, for the runner's prompts (en) and for the CLI and docs (pt).
// This is the only place the semantics of `total` is written as a sentence:
// the skills explain it to their role, and point here for the list.
export function autonomyRule(value, l = 'pt') {
  const a = autonomyOf(value);
  const x = lang(l);
  if (a === 'total') {
    const body = x === 'pt'
      ? 'liberdade total dentro do run — NÃO vão à fila do Sponsor: dependências gratuitas, sem conta e com licença permissiva (o Technology Scout decide e regista em docs/forja/TECHNOLOGY.md; o Dev pode instalá-las no ambiente do projeto — venv, node_modules — com o comando exato registado em DECISIONS.md), e escolhas de produto e de design que tenham um default razoável (o Product Manager e o Product Designer decidem e registam em DECISIONS.md como «decidido em autonomia total»).'
      : 'full freedom inside the run — these do NOT go to the Sponsor queue: a free dependency with no account and a permissive licence (the Technology Scout decides it and records it in docs/forja/TECHNOLOGY.md; the Dev may install it in the project environment — venv, node_modules — with the exact command recorded in DECISIONS.md), and product or design choices that have a reasonable default (the Product Manager and the Product Designer decide and record them in DECISIONS.md as "decidido em autonomia total").';
    return `${body} ${queueAlwaysLine(x)} ${roadmapRule(x)}`;
  }
  return x === 'pt'
    ? 'comportamento de sempre — uma dependência nova (mesmo gratuita), uma direção de design e qualquer escolha reservada ao Sponsor vão à fila com o default aplicado (`forja ask`), e nada se instala sem ele.'
    : 'today\'s behaviour — a new dependency (even a free one), a design direction and any choice reserved to the Sponsor go to the queue with the default applied (`forja ask`), and nothing is installed without him.';
}

// `<label> — <rule>`, for `forja autonomy show` and the handover.
export const describeAutonomy = (value, l = 'pt') => `${autonomyLabelOf(value)} — ${autonomyRule(value, l)}`;
