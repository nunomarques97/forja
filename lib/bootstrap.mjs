// `forja bootstrap <repo> [--dry-run]` prepares a repo for Core, exactly as
// `forja core init` does (lib/core/init.mjs): managed Core guidance, `.forja/`
// ignored, legacy skills made manual-only and legacy crew agents archived.
// Outside the target, one more write: the project is registered in
// <forja>/data/projects.json (lib/projects.mjs) so the viewer lists it.
// --dry-run computes the same summary and writes nothing, not even the registry.
// Prints a JSON summary of what init changed and of the registration.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { forjaRoot } from './state-files.mjs';
import { projectsPath, upsertProject } from './projects.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const normKey = p => fwd(resolve(p)).replace(/\/+$/, '').toLowerCase();

// legacy-references:allow-begin
// The legacy crew install was removed in 0.22.0. Its flags are refused before
// anything is read or written. The parser stores a flag followed by a word as
// that word (`bootstrap --legacy <repo>`), so any value counts as present.
export const REMOVED_FLAGS = ['legacy', 'keep-legacy'];
export function removedFlagProblem(opt = {}) {
  const used = REMOVED_FLAGS.filter(flag => opt[flag] !== undefined);
  if (used.length === 0) return null;
  return `bootstrap ${used.map(flag => `--${flag}`).join(' ')} was removed in 0.22.0: the legacy crew install no longer exists. Run \`forja core init\` in the repository, or \`forja bootstrap <repo>\` without flags. Nothing was written.`;
}
// legacy-references:allow-end

// Validates the target folder. Never writes.
export function resolveTarget(targetArg, forja = forjaRoot) {
  if (!targetArg) throw new Error('uso: forja bootstrap <caminho-do-repo> [--dry-run]');
  const target = resolve(String(targetArg));
  if (!existsSync(target)) throw new Error(`bootstrap: ${target} não existe`);
  if (!statSync(target).isDirectory()) throw new Error(`bootstrap: ${target} não é uma pasta`);
  const tKey = normKey(target); const fKey = normKey(forja);
  if (tKey === fKey) throw new Error('bootstrap: o alvo é o próprio repo do Forja — nada a fazer');
  if (fKey.startsWith(tKey + '/')) throw new Error(`bootstrap: ${target} contém o repo do Forja — escolhe o repo do projeto, não uma pasta acima`);
  return target;
}

export async function bootstrap({ pos = [], opt = {} } = {}) {
  const removed = removedFlagProblem(opt);
  if (removed) throw new Error(removed);
  const dryRun = opt['dry-run'] === true;
  const target = resolveTarget(pos[0], forjaRoot);
  const { initCore } = await import('./core/init.mjs');
  const summary = { ok: true, mode: 'core', target, dryRun, ...initCore(target, { dryRun }) };
  // A bootstrapped project is registered in <forja>/data/projects.json so the
  // viewer lists it. A registry failure never fails the bootstrap — the files
  // are already in place.
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
