import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { inside } from './context.mjs';
import { LEGACY_SKILLS, disableLegacySkill, migrateInstructions } from './instructions.mjs';
const OUTPUTS = ['AGENTS.md', 'CLAUDE.md', '.gitignore'];
function kind(stat) {
  if (stat.isSymbolicLink()) return 'a symbolic link or junction';
  if (stat.isDirectory()) return 'a directory';
  if (stat.isFile()) return 'a regular file';
  return 'a special file';
}
// Every target is inspected with lstat before any mutation, so a final link is
// rejected rather than followed; inside() also checks project containment.
function preflight(root) {
  const outputs = OUTPUTS.map((name) => {
    const stat = lstatSync(join(root, name), { throwIfNoEntry: false });
    if (stat && !stat.isFile())
      throw new Error(`${name} must be a regular file, found ${kind(stat)}.`);
    const path = inside(root, name);
    return { name, path, before: stat ? readFileSync(path) : null };
  });
  // Existing compatibility methods are retained, but cannot select themselves.
  // Resolve every ancestor before inspecting the file (including absent leaves).
  for (const skill of LEGACY_SKILLS) {
    const name = `.claude/skills/${skill}/SKILL.md`;
    const path = inside(root, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`${name} must be a regular file, found ${kind(stat)}.`);
    outputs.push({ name, path, before: readFileSync(path), skill });
  }
  const stat = lstatSync(join(root, '.forja'), { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
    throw new Error(`.forja must be a real directory, found ${kind(stat)}.`);
  return { outputs, state: inside(root, '.forja'), stateExists: Boolean(stat) };
}
// Best effort: every action runs even after one fails; only names and codes are reported.
function rollback(journal) {
  const failed = [];
  for (const entry of [...journal].reverse()) {
    try {
      if (entry.directory) {
        try {
          // Never recurse: a directory populated during failure stays intact.
          rmdirSync(entry.path);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      } else if (entry.before) writeFileSync(entry.path, entry.before);
      else
        try {
          unlinkSync(entry.path);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
    } catch (error) {
      failed.push({ file: entry.name, code: String(error?.code || 'UNKNOWN') });
    }
  }
  return failed;
}
export function initCore(root) {
  root = resolve(root);
  if (!existsSync(root)) throw new Error('Project directory does not exist.');
  const { outputs, state, stateExists } = preflight(root);
  const operations = [];
  for (const output of outputs.slice(0, 2)) {
    const before = output.before ? output.before.toString('utf8') : '';
    const next = migrateInstructions(before, output.name);
    operations.push([output, next]);
  }
  for (const output of outputs.slice(3))
    operations.push([output, disableLegacySkill(output.before.toString('utf8'), output.skill)]);
  const ignore = outputs[2],
    text = ignore.before ? ignore.before.toString('utf8') : '';
  if (!text.split(/\r?\n/).includes('.forja/'))
    operations.push([
      ignore,
      text + (text && !text.endsWith('\n') ? '\n' : '') + '.forja/\n',
    ]);
  const journal = [];
  try {
    for (const [output, content] of operations) {
      if (output.before?.equals(Buffer.from(content, 'utf8'))) continue;
      journal.push(output);
      writeFileSync(output.path, content);
    }
    if (!stateExists) {
      // Record the attempt before I/O, just as for writes: a wrapper can report
      // failure after creation. An absent directory is harmless during rollback.
      journal.push({ name: '.forja', path: state, directory: true });
      try {
        mkdirSync(state);
      } catch (error) {
        // A known collision belongs to someone else; do not remove that path.
        if (error?.code === 'EEXIST') journal.pop();
        throw error;
      }
    }
  } catch (error) {
    const failed = rollback(journal);
    if (!failed.length) throw error;
    const detail = failed.map((f) => `${f.file} (${f.code})`).join(', ');
    throw Object.assign(
      new Error(`core init failed and rollback is incomplete: ${detail}`, {
        cause: error,
      }),
      { rollback: failed },
    );
  }
  return {
    project: root,
    files: outputs.map((output) => output.name),
    note: 'Existing instructions retained; no role catalog or settings copied.',
  };
}
