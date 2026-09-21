import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CORE_ROOT } from './engine.mjs';
import { inside } from './context.mjs';
export function initCore(root) {
  root = resolve(root);
  if (!existsSync(root)) throw new Error('Project directory does not exist.');
  const begin = '<!-- forja-core:begin -->',
    end = '<!-- forja-core:end -->';
  const block = `${begin}\n## FORJA core\nShared workflow: read \`${CORE_ROOT.replaceAll('\\', '/')}/docs/CORE.md\` when running a FORJA task.\nStart: \`node "${CORE_ROOT.replaceAll('\\', '/')}/bin/forja.mjs" start --goal "..." --provider claude|codex\`.\nState and usage: \`.forja/\`. Do not load the legacy crew for core tasks.\n${end}`;
  const operations = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const p = inside(root, name),
      before = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const start = before.indexOf(begin),
      finish = before.indexOf(end);
    if (
      start < 0 !== finish < 0 ||
      finish < start ||
      (start >= 0 &&
        (before.indexOf(begin, start + begin.length) >= 0 ||
          before.indexOf(end, finish + end.length) >= 0))
    )
      throw new Error(`Unmatched managed markers in ${name}`);
    const next =
      start < 0
        ? `${before}${before && !before.endsWith('\n') ? '\n' : ''}\n${block}\n`
        : before.slice(0, start) + block + before.slice(finish + end.length);
    operations.push([p, next]);
  }
  const ignore = inside(root, '.gitignore'),
    text = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (!text.split(/\r?\n/).includes('.forja/'))
    operations.push([
      ignore,
      text + (text && !text.endsWith('\n') ? '\n' : '') + '.forja/\n',
    ]);
  const state = inside(root, '.forja');
  for (const [path, content] of operations) writeFileSync(path, content);
  mkdirSync(state, { recursive: true });
  return {
    project: root,
    files: ['AGENTS.md', 'CLAUDE.md', '.gitignore'],
    note: 'Existing instructions retained; no role catalog or settings copied.',
  };
}
