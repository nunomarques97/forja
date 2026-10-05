import {
  readFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { git, inside, repoFiles } from './files.mjs';
export { git, inside, repoFiles } from './files.mjs';
import { retrieveKnowledge } from './knowledge.mjs';
import { taskScope } from './task-scope.mjs';
import { technologyContext } from './technology.mjs';
import { specialistContext } from './specialists.mjs';
import { planningContract, PACKET_LIMIT, TASK_PACKET_BUDGET } from './plan-warnings.mjs';
import { RunStop } from './recovery.mjs';
import { lessonsEnabled, selectLessons } from './lessons.mjs';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../atomic-write.mjs';

// A missing file is absent from the snapshot, whether or not the user's
// index still lists it: installing a task commit that records a deletion
// must not change the hash of an unchanged working tree.
export function snapshot(root) {
  return Object.fromEntries(
    repoFiles(root).flatMap((p) => {
      // Contain the parent, not the entry: a link is recorded by its target
      // text and never followed, so a dangling link is ordinary content.
      const f = join(inside(root, dirname(p)), basename(p));
      try {
        const s = lstatSync(f);
        return [[
          p,
          s.isSymbolicLink()
            ? `link:${readlinkSync(f)}`
            : s.isFile()
              ? createHash('sha256').update(readFileSync(f)).digest('hex')
              : 'non-file',
        ]];
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return [];
      }
    }),
  );
}
export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    // Snapshots stored before missing files were omitted record them as null.
    .filter((p) => (before[p] ?? null) !== (after[p] ?? null))
    .sort();
}
// The hash of a snapshot taken earlier; treeHash(root) of the same tree.
export function snapshotHash(snap) {
  return createHash('sha256')
    .update(JSON.stringify(snap))
    .digest('hex');
}
export function treeHash(root) {
  return snapshotHash(snapshot(root));
}
// Map budget of the plan packet, which explores the whole repository, and of
// task packets, which list the task's own files first and then the closest
// paths. Measured on recorded real packets (docs/EFFICIENCY.md): the smaller
// task budget drops no task file, while a plain 3,000 cut without the pin
// dropped 16% of them.
export const PLAN_MAP_CHARACTERS = 6000;
export const TASK_MAP_CHARACTERS = 3000;
export function repoMap(root, query = '', maxChars = PLAN_MAP_CHARACTERS, pinned = []) {
  const own = new Set((pinned || []).map((p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '')));
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
    (f) => !/^docs\/forja\/(reports|archive|legacy-agents)\//.test(f),
  );
  const ranked = files
    .map((p) => ({
      p,
      score: words.reduce(
        (n, w) => n + (p.toLowerCase().includes(w) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => own.has(b.p) - own.has(a.p) || b.score - a.score || a.p.localeCompare(b.p));
  const lines = [];
  let used = 0;
  for (const { p } of ranked) {
    let line = p;
    if (used + p.length + 1 > maxChars) continue;
    let f, stat;
    try {
      f = inside(root, p);
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
  writeFileAtomic(indexPath, JSON.stringify(index));
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
// Optional context, degraded in this order only when a packet exceeds its limit
// (PACKET_LIMIT for workers): lessons from earlier runs (present only with the
// run config flag), criteria of other remaining tasks (the plan
// pointer stays), optional knowledge excerpt text (paths, lines, hashes,
// references and required notes stay), then the repository map text.
// Everything else is mandatory.
const DEGRADATIONS = [
  {
    source: 'trimmed lessons',
    apply: (data) => {
      if (!data.lessons) return false;
      const { lessons, ...rest } = data;
      return rest;
    },
  },
  {
    source: 'trimmed task_scope.remaining_tasks criteria',
    apply: (data) => data.task_scope?.remaining_tasks?.some((t) => 'criteria' in t) && {
      ...data,
      task_scope: {
        ...data.task_scope,
        remaining_tasks: data.task_scope.remaining_tasks.map(({ criteria, criteria_truncated, ...entry }) => entry),
      },
    },
  },
  {
    source: 'trimmed knowledge excerpts',
    apply: (data) => data.knowledge?.selected?.some((k) => !k.required && 'text' in k) && {
      ...data,
      knowledge: {
        ...data.knowledge,
        selected: data.knowledge.selected.map(({ text, ...reference }) =>
          reference.required ? { ...reference, text } : { ...reference, excerpt_omitted: true }),
        note: 'Optional excerpt text was omitted to fit the packet limit; read the listed paths and lines when relevant.',
      },
    },
  },
  {
    source: 'trimmed repository_map',
    apply: (data) => data.repository_map?.text && {
      ...data,
      repository_map: { ...data.repository_map, text: '', filesShown: 0, omitted: 'Repository map text was omitted to fit the packet limit; locate files with search tools.' },
    },
  },
];

function fitPacket(data, limit) {
  let text = JSON.stringify(data);
  const trimmed = [];
  for (const { source, apply } of DEGRADATIONS) {
    if (text.length <= limit) break;
    const next = apply(data);
    if (!next) continue;
    const smaller = JSON.stringify(next);
    trimmed.push({ source, characters: 0, trimmed_characters: text.length - smaller.length });
    for (const key of Object.keys(data)) if (!(key in next)) delete data[key];
    Object.assign(data, next);
    text = smaller;
  }
  return { text, trimmed };
}

export function packet({
  root,
  run,
  task,
  phase,
  feedback = null,
  changes = null,
  limit = PACKET_LIMIT,
}) {
  const map = task
    ? repoMap(root, `${task.title} ${(task.files || []).join(' ')}`, TASK_MAP_CHARACTERS, task.files)
    : repoMap(root, run.goal, PLAN_MAP_CHARACTERS);
  const knowledge = retrieveKnowledge(
    root,
    task
      ? `${task.title} ${(task.files || []).join(' ')} ${task.criteria.join(' ')}`
      : run.goal,
  );
  const specialists = specialistContext(root, run, phase);
  const lessons = lessonsEnabled(run) ? selectLessons(root, run, task, phase) : null;
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
    ...(phase === 'plan' ? { planning_contract: planningContract(run) } : {}),
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
    ...(lessons?.section ? { lessons: lessons.section } : {}),
  };
  const { text, trimmed } = fitPacket(data, limit);
  if (text.length > limit) {
    const size = `${text.length.toLocaleString('en-US')} characters, over the limit of ${limit.toLocaleString('en-US')} characters`;
    const error = new RunStop(
      'task_packet',
      `Task packet ${task ? `for ${task.id} (${phase}) ` : `for ${phase} `}has ${size}${trimmed.length ? ` after trimming optional context (${trimmed.map(t => t.source.replace(/^trimmed /, '')).join(', ')})` : ''}; its mandatory parts alone exceed the limit, so split the task or shorten explicit decision data. Criteria were not truncated. No session or implementation attempt was spent.`,
    );
    error.detail = { limit, tasks: [{ task: task?.id ?? null, phase, characters: text.length }] };
    error.characters = text.length;
    throw error;
  }
  return {
    text,
    sources: [
      ...Object.entries(data).map(([source, value]) => ({
        source,
        characters: JSON.stringify(value).length,
      })),
      ...trimmed,
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
    ...(lessons
      ? {
          lessons: {
            ids: data.lessons ? lessons.ids : [],
            ...(lessons.section && !data.lessons ? { trimmed: true } : {}),
            ...(lessons.warning ? { warning: lessons.warning } : {}),
          },
        }
      : {}),
    characters: text.length,
    estimated_tokens: Math.ceil(text.length / 4),
    estimate_method:
      'characters/4 proxy, excludes provider system/tools/instructions',
  };
}

// Measures the first develop packet of every task of a candidate plan with the
// real builder, degrading optional context against the planning budget as the
// worker packet does against PACKET_LIMIT, and returns the tasks over the
// budget, largest first. Each entry also gives the size of the task's own entry
// to point at the cause.
export function planPacketProblems(root, run, tasks, decisions = []) {
  const planned = { ...run, tasks, decisions, phase: 'work' };
  return tasks
    .map((task) => {
      const own = JSON.stringify({ id: task.id, title: task.title, criteria: task.criteria, files: task.files, risks: task.risks, checks: task.checks }).length;
      try {
        return { task: task.id, characters: packet({ root, run: planned, task, phase: 'develop', limit: TASK_PACKET_BUDGET }).characters, own };
      } catch (error) {
        if (!Number.isSafeInteger(error.characters)) throw error;
        return { task: task.id, characters: error.characters, own };
      }
    })
    .filter((entry) => entry.characters > TASK_PACKET_BUDGET)
    .sort((a, b) => b.characters - a.characters);
}
