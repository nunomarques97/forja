import { closeSync, lstatSync, mkdtempSync, mkdirSync, openSync, readSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A native tool policy, not an OS sandbox for arbitrary child processes.
export function validateWorkerAccess(provider, config = {}) {
  if (config.writePolicy === undefined) return;
  if (config.writePolicy !== 'restricted') throw new Error('Invalid provider writePolicy.');
  if (provider !== 'claude') throw new Error('Restricted writePolicy currently requires Claude.');
  if (config.fullAccess === true) throw new Error('Restricted writePolicy conflicts with fullAccess.');
  if (config.args?.length) throw new Error('Restricted writePolicy refuses extra CLI arguments.');
}

export function restrictedSettings(protectedPaths = []) {
  if (!Array.isArray(protectedPaths) || protectedPaths.length > 100) throw new Error('Invalid restricted protected paths.');
  const paths = ['.forja', '.git', '.claude', '.codex', ...protectedPaths];
  const deny = [];
  for (const value of paths) {
    // No glob semantics supplied by a caller; escape literal gitignore characters.
    if (typeof value !== 'string' || !value || /[\x00-\x1f:]/.test(value)) throw new Error('Invalid restricted protected path.');
    const parts = value.replaceAll('\\', '/').split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) throw new Error('Invalid restricted protected path.');
    const literal = parts.join('/').replace(/[!*?\[\]]/g, '\\$&');
    deny.push(`Edit(./${literal})`, `Edit(./${literal}/**)`);
  }
  return { disableAllHooks: true, permissions: { deny: [...new Set(deny)] } };
}

export function restrictedMcp(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Restricted writePolicy requires an empty MCP configuration.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'mcpServers') ||
      !value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers) || Object.keys(value.mcpServers).length)
    throw new Error('Restricted writePolicy requires an empty MCP configuration.');
}

export function workerScratch() {
  const owner = mkdtempSync(join(realpathSync(tmpdir()), 'forja-worker-'));
  const scratch = join(owner, 'scratch');
  mkdirSync(scratch, { mode: 0o700 });
  return scratch;
}

export function workerAccessPrompt({ scratch, restricted, readOnly }) {
  return `\nFORJA invocation access: ${restricted ? 'restricted native file tools; no shell, Git, subagents, MCP or code execution' : 'native provider permissions; scratch allocation is not confinement'}. ` +
    `The only authorized temporary directory is ${JSON.stringify(scratch)} (also FORJA_SCRATCH_DIR, TMPDIR, TEMP and TMP). Do not use shared /tmp names. ` +
    (restricted ? readOnly ? 'This phase has only read tools. Inspect scheduler check logs; do not write files or claim to run probes. ' : 'Edit source and tests through the file tools. Return ready_for_validation with executable checks for the controller; no worker commands are available. ' : '') +
    'Do not modify Git metadata, stash, scheduler state or protected acceptance files. Scratch is private run evidence and is retained; do not delete it.\n';
}

// Core-managed continuation notes for a develop session. The file lives in the
// invocation scratch (never in project files); the controller seeds it with the
// previous session's notes and reads it back after the session ends.
export const PROGRESS_NOTES_FILE = 'progress-notes.md';
export const PROGRESS_NOTES_READ_LIMIT = 64000;

export function seedProgressNotes(scratch, text = '') {
  const path = join(scratch, PROGRESS_NOTES_FILE);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

export function readProgressNotes(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, PROGRESS_NOTES_READ_LIMIT));
      return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
    } finally { closeSync(fd); }
  } catch { return null; }
}

export function progressNotesPrompt(path, contextLimit = null) {
  return `FORJA progress notes: keep ${JSON.stringify(path)} current, under 6,000 characters: what is done, what you read and concluded (with file paths), remaining steps and the relevant files. ` +
    'Update it after each significant finding or edit, before reading further. It already holds the notes of earlier sessions of this task; revise it rather than starting over. ' +
    (contextLimit ? `The controller stops this session without warning when observed request context reaches ${contextLimit} tokens; ` : 'If this session stops early, ') +
    'the next session of this task receives these notes. They are run evidence, not a deliverable: never write them into project files.\n';
}
