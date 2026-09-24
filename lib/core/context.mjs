import {
  readFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { git, inside, repoFiles } from './files.mjs';
export { git, inside, repoFiles } from './files.mjs';
import { retrieveKnowledge } from './knowledge.mjs';
import { taskScope } from './task-scope.mjs';
import { technologyContext } from './technology.mjs';
import { specialistContext } from './specialists.mjs';
import { createHash, randomUUID } from 'node:crypto';

export function snapshot(root) {
  return Object.fromEntries(
    repoFiles(root).map((p) => {
      const f = inside(root, p);
      try {
        const s = lstatSync(f);
        return [
          p,
          s.isSymbolicLink()
            ? `link:${readlinkSync(f)}`
            : s.isFile()
              ? createHash('sha256').update(readFileSync(f)).digest('hex')
              : 'non-file',
        ];
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return [p, null];
      }
    }),
  );
}
export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((p) => before[p] !== after[p])
    .sort();
}
export function treeHash(root) {
  return createHash('sha256')
    .update(JSON.stringify(snapshot(root)))
    .digest('hex');
}
export function repoMap(root, query = '', maxChars = 6000) {
  const indexPath = inside(root, '.forja/index.json');
  let previous = {};
  try {
    previous = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {}
  const index = {};
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  const files = repoFiles(root).filter(
    (f) => !/^docs\/forja\/(reports|archive)\//.test(f),
  );
  const ranked = files
    .map((p) => ({
      p,
      score: words.reduce(
        (n, w) => n + (p.toLowerCase().includes(w) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.p.localeCompare(b.p));
  const lines = [];
  let used = 0;
  for (const { p } of ranked) {
    let line = p;
    const f = inside(root, p);
    if (used + p.length + 1 > maxChars) continue;
    let stat;
    try {
      stat = lstatSync(f);
    } catch {
      continue;
    }
    if (
      /\.(m?[jt]sx?|py|rs|go)$/.test(p) &&
      stat.isFile() &&
      stat.size < 64000
    ) {
      const key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      let entry = previous[p];
      if (!entry || entry.key !== key || !Array.isArray(entry.symbols)) {
        const source = readFileSync(f, 'utf8');
        const symbols = [
          ...source.matchAll(
            /^(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|func)\s+(\w+)/gm,
          ),
        ]
          .map((m) => m[1])
          .slice(0, 8);
        entry = {
          key,
          hash: createHash('sha256').update(source).digest('hex'),
          symbols,
        };
      }
      index[p] = entry;
      if (entry.symbols.length) line += ` :: ${entry.symbols.join(', ')}`;
    }
    if (used + line.length + 1 > maxChars) continue;
    lines.push(line);
    used += line.length + 1;
  }
  mkdirSync(join(root, '.forja'), { recursive: true });
  const tmp = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(index), { flag: 'wx' });
  renameSync(tmp, indexPath);
  return {
    text: lines.join('\n'),
    filesTotal: files.length,
    filesShown: lines.length,
    method:
      'lexical paths + heuristic declarations; retrieve source before editing',
  };
}
export function risks(task, files = [], diff = '') {
  const text = [...(task.risks || []), ...files, diff].join('\n');
  return {
    security:
      task.risks?.includes('security') ||
      /(auth|credential|secret|session|token|password|cors|webhook|\.env|package(?:-lock)?\.json|requirements|cargo\.lock|exec\(|spawn\(|eval\(|https?:|fetch\(|listen\()/i.test(
        text,
      ),
    visual:
      task.risks?.includes('visual') ||
      files.some((f) => /\.(html|css|tsx|jsx|vue|svelte)$/.test(f)),
    architecture:
      task.risks?.includes('architecture') || task.complexity === 'hard',
  };
}
export function packet({
  root,
  run,
  task,
  phase,
  feedback = null,
  changes = null,
}) {
  const map = repoMap(
    root,
    task ? `${task.title} ${(task.files || []).join(' ')}` : run.goal,
  );
  const knowledge = retrieveKnowledge(
    root,
    task
      ? `${task.title} ${(task.files || []).join(' ')} ${task.criteria.join(' ')}`
      : run.goal,
  );
  const specialists = specialistContext(root, run, phase);
  const data = {
    goal: run.goal,
    phase,
    ...(specialists ? { specialist_context: specialists } : {}),
    task: task
      ? {
          id: task.id,
          title: task.title,
          criteria: task.criteria,
          files: task.files,
          risks: task.risks,
          checks: task.checks,
        }
      : null,
    decisions: run.decisions || [],
    ...(run.technology?.length ? { technology: technologyContext(run) } : {}),
    final_checks: run.config?.finalChecks || [],
    ...(run.protectedFiles?.length ? { protected_files: run.protectedFiles.map(entry => entry.path) } : {}),
    task_scope: taskScope(run, task),
    ...(phase === 'develop' && task?.progress_notes?.text?.trim()
      ? {
          progress_notes: {
            text: task.progress_notes.text,
            from_invocation: task.progress_notes.invocation,
            ...(task.progress_notes.truncated ? { truncated: true } : {}),
            note: 'Written by an earlier session of this task; verify against current source before relying on it.',
          },
        }
      : {}),
    completed: run.tasks
      .filter((t) => t.status === 'done')
      .map((t) => ({ id: t.id, title: t.title })),
    feedback,
    changes,
    repository_map: map,
    knowledge: {
      selected: knowledge.selected,
      ...(knowledge.references.length ? { references: knowledge.references } : {}),
      warnings: knowledge.warnings,
      method: knowledge.method,
    },
  };
  const text = JSON.stringify(data);
  if (text.length > 48000)
    throw new Error(
      'Task packet exceeds 48,000 characters; split the task or shorten explicit decision data. Criteria were not truncated.',
    );
  return {
    text,
    sources: [
      ...Object.entries(data).map(([source, value]) => ({
        source,
        characters: JSON.stringify(value).length,
      })),
      {
        source: 'packet JSON framing',
        characters:
          text.length -
          Object.values(data).reduce((n, v) => n + JSON.stringify(v).length, 0),
      },
    ],
    retrieval: {
      ...knowledge,
      selected: knowledge.selected.map(({ text, ...reference }) => reference),
    },
    characters: text.length,
    estimated_tokens: Math.ceil(text.length / 4),
    estimate_method:
      'characters/4 proxy, excludes provider system/tools/instructions',
  };
}
