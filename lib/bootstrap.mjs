// `forja bootstrap <repo> [--dry-run]` prepares a repo for Core, exactly as
// `forja core init` does (see bootstrap() below). The legacy crew install
// described next runs only with an explicit `--legacy`.
// `forja bootstrap <repo> --legacy [--dry-run]` — installs the legacy crew into another repo,
// idempotently, never rewriting content that is not ours (docs/ARCHITECTURE.md §13):
//   .claude/agents/{architect,product-manager,product-designer,technology-scout,backend-dev,frontend-dev,reviewer,qa,security-reviewer}.md   copied (ours overwritten, others kept)
//   .claude/skills/forja-*/                                     copied (ours overwritten, others kept)
//   .claude/settings.json                                       deep-merged: target's env/hooks/keys kept;
//                                                               Forja env ensured, fallbackModel added if absent,
//                                                               one log-event hook per event (absolute path to
//                                                               this repo's hooks/log-event.mjs) unless present
//   docs/forja/TASKS.json, DECISIONS.md, SPONSOR-QUEUE.md       created only if missing (run state, never touched)
//   CLAUDE.md                                                   created if missing; one managed block between
//                                                               <!-- forja:begin --> / <!-- forja:end --> replaced,
//                                                               everything outside it untouched
// Outside the target, one more write: the project is registered in
// <forja>/data/projects.json (lib/projects.mjs) so the viewer can start a run
// there from the phone. --dry-run registers nothing.
// Prints a JSON summary { created, updated, unchanged, registry }. --dry-run computes
// the same summary and writes nothing. Pure planning is exported for tests.
import { coreInstructions } from './core/instructions.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync , rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { DECISIONS_HEADER, QUEUE_HEADER, forjaRoot } from './state-files.mjs';
import { projectsPath, upsertProject } from './projects.mjs';

export const LEGACY_AGENTS = ['ferreiro', 'bigorna', 'tracador', 'fundidor', 'lapidador', 'contraste'];
export const LEGACY_SKILLS = ['forja-decide'];
export const AGENTS = ['architect', 'product-manager', 'product-designer', 'technology-scout', 'backend-dev', 'frontend-dev', 'reviewer', 'qa', 'security-reviewer'];
export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'SessionEnd',
];
export const FORJA_ENV = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' };
export const MARK_BEGIN = '<!-- forja:begin -->';
export const MARK_END = '<!-- forja:end -->';

const fwd = p => String(p).replace(/\\/g, '/');
const normKey = p => fwd(resolve(p)).replace(/\/+$/, '').toLowerCase();

export function hookCommand(forja = forjaRoot) {
  return `node "${fwd(forja)}/hooks/log-event.mjs"`;
}
export function hookEntry(event, forja = forjaRoot) {
  return { type: 'command', command: hookCommand(forja), timeout: event === 'SessionEnd' ? 5 : 10 };
}

// Deep-merge our settings into the target's. Returns a new object; the input is not mutated.
export function mergeSettings(existing, forja = forjaRoot) {
  const s = structuredClone(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {});
  const warnings = [];
  if (!s.env || typeof s.env !== 'object' || Array.isArray(s.env)) s.env = {};
  for (const [k, v] of Object.entries(FORJA_ENV)) s.env[k] = v;
  if (s.fallbackModel === undefined) s.fallbackModel = ['opus'];
  if (!s.hooks || typeof s.hooks !== 'object' || Array.isArray(s.hooks)) s.hooks = {};
  const command = hookCommand(forja);
  for (const event of HOOK_EVENTS) {
    const groups = s.hooks[event];
    if (groups === undefined) { s.hooks[event] = [{ hooks: [hookEntry(event, forja)] }]; continue; }
    if (!Array.isArray(groups)) { warnings.push(`hooks.${event} não é uma lista — deixado como está, hook do Forja não adicionado`); continue; }
    const present = groups.some(g => g && Array.isArray(g.hooks) && g.hooks.some(h => h && h.command === command));
    if (!present) groups.push({ hooks: [hookEntry(event, forja)] });
  }
  return { settings: s, warnings };
}

export function managedBlock(forja = forjaRoot) {
  return [MARK_BEGIN, coreInstructions(), MARK_END].join('\n');
}

// Ensure exactly one managed block in the text: replace the first, drop any
// duplicates, append at the end when absent. Text outside the block is untouched;
// the block takes the file's own line endings (a CRLF CLAUDE.md stays CRLF).
export function detectEol(text) { return /\r\n/.test(text) ? '\r\n' : '\n'; }
export function upsertManagedBlock(text, block) {
  const eol = detectEol(text);
  const b = block.replace(/\r?\n/g, eol);
  const re = new RegExp(`${escapeRe(MARK_BEGIN)}[\\s\\S]*?${escapeRe(MARK_END)}`, 'g');
  const found = text.match(re) || [];
  if (found.length === 0) {
    const sep2 = text.length === 0 ? '' : text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol;
    return text + sep2 + b + eol;
  }
  let i = 0;
  let out = text.replace(re, () => (i++ === 0 ? b : ''));
  if (found.length > 1) out = out.replace(eol === '\r\n' ? /(\r\n){3,}/g : /\n{3,}/g, eol + eol);
  return out;
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out;
}

// Computes every file the bootstrap would write, with its action. Never writes.
function resolveTarget(targetArg, forja) {
  if (!targetArg) throw new Error('uso: forja bootstrap <caminho-do-repo> [--dry-run] [--legacy]');
  const target = resolve(String(targetArg));
  if (!existsSync(target)) throw new Error(`bootstrap: ${target} não existe`);
  if (!statSync(target).isDirectory()) throw new Error(`bootstrap: ${target} não é uma pasta`);
  const tKey = normKey(target); const fKey = normKey(forja);
  if (tKey === fKey) throw new Error('bootstrap: o alvo é o próprio repo do Forja — nada a fazer');
  if (fKey.startsWith(tKey + '/')) throw new Error(`bootstrap: ${target} contém o repo do Forja — escolhe o repo do projeto, não uma pasta acima`);
  return target;
}

export function planBootstrap(targetArg, { forja = forjaRoot, keepLegacy = false } = {}) {
  const target = resolveTarget(targetArg, forja);
  const ops = []; const warnings = [];
  const add = (abs, content, { onlyIfMissing = false } = {}) => {
    const exists = existsSync(abs);
    const rel = fwd(relative(target, abs));
    if (exists && onlyIfMissing) { ops.push({ rel, abs, action: 'unchanged' }); return; }
    if (exists && Buffer.compare(readFileSync(abs), Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')) === 0) { ops.push({ rel, abs, action: 'unchanged' }); return; }
    ops.push({ rel, abs, action: exists ? 'update' : 'create', content });
  };

  // 2. agents (ours only)
  for (const a of AGENTS) {
    const src = join(forja, '.claude', 'agents', `${a}.md`);
    if (!existsSync(src)) { warnings.push(`agente ${a}.md não existe no Forja — saltado`); continue; }
    add(join(target, '.claude', 'agents', `${a}.md`), readFileSync(src));
  }
  // 2b. legacy forge-named files an earlier bootstrap installed: removed (they would be
  // a second, stale copy of the same role) unless the file does not mention Forja or
  // the caller passed --keep-legacy; every removal is listed in the summary.
  for (const a of keepLegacy ? [] : LEGACY_AGENTS) {
    const abs = join(target, '.claude', 'agents', `${a}.md`);
    // Only a file that is really ours (it mentions Forja) — a user's own file with the same name is kept.
    if (existsSync(abs) && /forja/i.test(readFileSync(abs, 'utf8'))) ops.push({ rel: fwd(relative(target, abs)), abs, action: 'remove' });
    else if (existsSync(abs)) warnings.push(`${fwd(relative(target, abs))} tem um nome antigo do Forja mas não parece nosso — mantido`);
  }
  for (const s of keepLegacy ? [] : LEGACY_SKILLS) {
    const abs = join(target, '.claude', 'skills', s);
    if (!existsSync(abs)) continue;
    const skill = join(abs, 'SKILL.md');
    if (existsSync(skill) && /forja/i.test(readFileSync(skill, 'utf8'))) ops.push({ rel: fwd(relative(target, abs)), abs, action: 'remove', dir: true });
    else warnings.push(`${fwd(relative(target, abs))} tem um nome antigo do Forja mas não parece nosso — mantido`);
  }
  // 3. skills forja-* (ours only, whole folder)
  const skillsDir = join(forja, '.claude', 'skills');
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    const src = join(skillsDir, name);
    if (!name.startsWith('forja-') || !statSync(src).isDirectory()) continue;
    for (const file of listFiles(src)) add(join(target, '.claude', 'skills', name, relative(src, file)), readFileSync(file));
  }
  // 4. settings.json deep-merge
  const settingsPath = join(target, '.claude', 'settings.json');
  let existing = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch (err) { throw new Error(`bootstrap: ${settingsPath} não é JSON válido (${err.message}) — corrige-o primeiro; não o reescrevo`); }
  }
  const { settings, warnings: w } = mergeSettings(existing, forja);
  warnings.push(...w);
  if (existsSync(settingsPath) && JSON.stringify(settings) === JSON.stringify(existing)) ops.push({ rel: '.claude/settings.json', abs: settingsPath, action: 'unchanged' });
  else add(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  // 5. docs/forja (run state: created only when missing)
  add(join(target, 'docs', 'forja', 'TASKS.json'), '[]\n', { onlyIfMissing: true });
  add(join(target, 'docs', 'forja', 'DECISIONS.md'), DECISIONS_HEADER, { onlyIfMissing: true });
  add(join(target, 'docs', 'forja', 'SPONSOR-QUEUE.md'), QUEUE_HEADER, { onlyIfMissing: true });
  // 6. CLAUDE.md managed block
  const claudePath = join(target, 'CLAUDE.md');
  const before = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : `# ${basename(target)} — project rules\n\n`;
  add(claudePath, upsertManagedBlock(before, managedBlock(forja)));

  return { target, forja, ops, warnings };
}

export function applyPlan(plan) {
  for (const op of plan.ops) {
    if (op.action === 'unchanged') continue;
    if (op.action === 'remove') { rmSync(op.abs, { recursive: !!op.dir, force: true }); continue; }
    mkdirSync(dirname(op.abs), { recursive: true });
    writeFileSync(op.abs, op.content);
  }
}

export function summarize(plan, dryRun) {
  const pick = a => plan.ops.filter(o => o.action === a).map(o => o.rel);
  const s = { ok: true, target: plan.target, forja: plan.forja, dryRun: !!dryRun, created: pick('create'), updated: pick('update'), unchanged: pick('unchanged'), removed: pick('remove') };
  if (plan.warnings.length) s.warnings = plan.warnings;
  return s;
}

// Default: the same Core preparation as `core init` (managed Core guidance,
// `.forja/` ignored, legacy skills manual-only, legacy crew agents archived).
// The legacy crew install needs an explicit --legacy.
export async function bootstrap({ pos = [], opt = {} } = {}) {
  const dryRun = opt['dry-run'] === true;
  const legacy = opt.legacy === true;
  let summary;
  if (legacy) {
    const plan = planBootstrap(pos[0], { keepLegacy: opt['keep-legacy'] === true });
    if (!dryRun) applyPlan(plan);
    summary = { mode: 'legacy', ...summarize(plan, dryRun) };
  } else {
    const target = resolveTarget(pos[0], forjaRoot);
    const { initCore } = await import('./core/init.mjs');
    summary = { ok: true, mode: 'core', target, dryRun, ...initCore(target, { dryRun }) };
  }
  // A bootstrapped project is a project the Sponsor can start from the phone:
  // register it in <forja>/data/projects.json (docs/ARCHITECTURE.md §7b, §9).
  // A registry failure never fails the bootstrap — the files are already in place.
  if (!dryRun) {
    try {
      const entry = upsertProject({ path: summary.target });
      summary.registry = { registered: true, name: entry.name, bootstrappedAt: entry.bootstrappedAt, file: projectsPath() };
    } catch (err) {
      // An unreadable projects.json is left exactly as it is (lib/projects.mjs):
      // the bootstrap says so and names the file instead of writing over it.
      summary.registry = { registered: false, error: String(err && err.message), file: projectsPath() };
      (summary.warnings ||= []).push(`não consegui registar o projeto em projects.json (${err && err.message}) — arrancar pelo telemóvel não o vai listar`);
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}
