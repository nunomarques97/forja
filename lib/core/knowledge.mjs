// Bounded, provider-neutral retrieval over project-owned Markdown. Source-backed in-memory index.
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inside, repoFiles } from './files.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const stop = new Set(
  'the and for with from that this when then does have not are was how what para uma com dos das que por nao mais como'.split(
    ' ',
  ),
);
export const terms = (text) =>
  String(text)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !stop.has(t));
export function chunks(text, max = 1400) {
  const result = [],
    lines = text.split(/\r?\n/);
  let value = '',
    start = 1;
  const push = (end) => {
    if (value.trim()) result.push({ start, end, text: value });
    value = '';
  };
  lines.forEach((line, i) => {
    if (
      value &&
      (value.length + line.length + 1 > max ||
        (/^#{1,4} /.test(line) && value.length > 250))
    ) {
      push(i);
      start = i + 1;
    }
    while (line.length + 1 > max) {
      value = line.slice(0, max);
      push(i + 1);
      line = line.slice(max);
      start = i + 1;
    }
    if (!value) start = i + 1;
    value += line + '\n';
  });
  push(lines.length);
  return result;
}
export function rankChunks(entries, query) {
  const q = [...new Set(terms(query))],
    documents = entries.map((e) => terms(`${e.path}\n${e.text}`));
  const avg =
    documents.reduce((n, d) => n + d.length, 0) / (documents.length || 1);
  const df = new Map(
    q.map((t) => [t, documents.filter((d) => d.includes(t)).length]),
  );
  return entries
    .map((e, i) => {
      const d = documents[i];
      let score = 0;
      for (const t of q) {
        const tf = d.filter((w) => w === t).length;
        if (tf)
          score +=
            (Math.log(
              1 + (entries.length - df.get(t) + 0.5) / (df.get(t) + 0.5),
            ) *
              tf *
              2.2) /
            (tf + 1.2 * (0.25 + (0.75 * d.length) / (avg || 1)));
      }
      return { ...e, score: Math.round(score * 10000) / 10000 };
    })
    .filter((e) => e.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start,
    );
}

const defaults = [
  'docs/forja/PRODUCT-PROFILE.md',
  'docs/forja/TECHNOLOGY.md',
  'docs/forja/DECISIONS.md',
  'docs/design/DESIGN.md',
];
export function retrieveKnowledge(
  root,
  query,
  { budget = 6000, maxChunks = 6 } = {},
) {
  if (
    !Number.isInteger(budget) ||
    budget < 256 ||
    budget > 12000 ||
    !Number.isInteger(maxChunks) ||
    maxChunks < 1 ||
    maxChunks > 12
  )
    throw new Error('Invalid knowledge budget.');
  const started = performance.now(),
    manifestPath = inside(root, 'docs/forja/KNOWLEDGE.json');
  let specs, candidateDocuments;
  if (existsSync(manifestPath)) {
    if (lstatSync(manifestPath).size > 128000)
      throw new Error('Knowledge manifest exceeds 128 KB.');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (
      m.version !== 1 ||
      !Array.isArray(m.documents) ||
      m.documents.length > 200
    )
      throw new Error(
        'Invalid docs/forja/KNOWLEDGE.json: expected version 1 and at most 200 documents.',
      );
    specs = m.documents.map((d) => (typeof d === 'string' ? { path: d } : d));
    candidateDocuments = specs.length;
  } else {
    specs = [
      ...new Set([
        ...defaults.filter((p) => existsSync(inside(root, p))),
        ...repoFiles(root).filter(
          (p) =>
            /\.md$/i.test(p) &&
            !/(^|\/)(archive|reports|node_modules|\.claude|\.codex)\//i.test(
              p,
            ) &&
            !/(^|\/)(AGENTS|CLAUDE)\.md$/i.test(p),
        ),
      ]),
    ].map((path) => ({ path }));
    candidateDocuments = specs.length;
    specs = specs.slice(0, 200);
  }
  const candidates = [],
    required = [],
    warnings = [];
  if (candidateDocuments > specs.length)
    warnings.push(
      `Knowledge discovery limited to ${specs.length}/${candidateDocuments} documents; use a manifest to select the relevant corpus.`,
    );
  let bytes = 0,
    scanned = 0;
  const seenPaths = new Set();
  for (const spec of specs) {
    if (
      !spec ||
      typeof spec.path !== 'string' ||
      !/\.md$/i.test(spec.path) ||
      (spec.required !== undefined && typeof spec.required !== 'boolean')
    )
      throw new Error(
        'Knowledge documents must be Markdown paths with an optional boolean required flag.',
      );
    const path = spec.path.replaceAll('\\', '/'),
      file = inside(root, path);
    // Aliases such as ./note.md must not hide stronger later constraints.
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seenPaths.has(key))
      throw new Error(`Duplicate knowledge document: ${path}`);
    seenPaths.add(key);
    if (!existsSync(file)) {
      if (spec.required) throw new Error(`Required knowledge missing: ${path}`);
      warnings.push(`Missing knowledge: ${path}`);
      continue;
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 128000 || bytes + stat.size > 2000000) {
      if (spec.required)
        throw new Error(`Required knowledge exceeds indexing limits: ${path}`);
      warnings.push(`Skipped knowledge beyond indexing limits: ${path}`);
      continue;
    }
    bytes += stat.size;
    scanned++;
    const text = readFileSync(file, 'utf8'),
      digest = hash(text);
    const entry = { chunks: chunks(text) };
    let stale = false;
    if (spec.source_hashes !== undefined) {
      if (
        !spec.source_hashes ||
        typeof spec.source_hashes !== 'object' ||
        Array.isArray(spec.source_hashes)
      )
        throw new Error('source_hashes must be an object.');
      if (Object.keys(spec.source_hashes).length > 16)
        throw new Error('At most 16 source dependencies per note.');
      for (const [source, expected] of Object.entries(spec.source_hashes)) {
        if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))
          throw new Error('source_hashes requires SHA-256 values.');
        const dependency = inside(root, source);
        if (
          !existsSync(dependency) ||
          !lstatSync(dependency).isFile() ||
          lstatSync(dependency).size > 1000000 ||
          hash(readFileSync(dependency)) !== expected
        )
          stale = true;
      }
    }
    if (stale) {
      if (spec.required)
        throw new Error(
          `Required knowledge has stale source dependencies: ${path}`,
        );
      warnings.push(
        `Stale source dependency: ${path}; verify current source before relying on this note.`,
      );
      continue;
    }
    if (spec.required)
      required.push({
        path,
        start: 1,
        end: text.split(/\r?\n/).length,
        text,
        hash: digest,
        required: true,
      });
    else
      candidates.push(
        ...entry.chunks.map((c) => ({ ...c, path, hash: digest })),
      );
  }
  const selected = [...required];
  if (JSON.stringify(selected).length > budget)
    throw new Error(
      'Required knowledge exceeds packet budget; shorten the mandatory notes.',
    );
  const seen = new Set(selected.map((e) => hash(e.text)));
  for (const candidate of rankChunks(candidates, query)) {
    if (selected.length >= maxChunks) break;
    if (seen.has(hash(candidate.text))) continue;
    if (JSON.stringify([...selected, candidate]).length > budget) continue;
    selected.push(candidate);
    seen.add(hash(candidate.text));
  }
  return {
    method:
      'BM25 Markdown chunks; source remains authoritative; no semantic/AST index',
    selected,
    warnings,
    documents_scanned: scanned,
    candidate_documents: candidateDocuments,
    indexed_bytes: bytes,
    characters: JSON.stringify(selected).length,
    budget_characters: budget,
    duration_ms: Math.round((performance.now() - started) * 100) / 100,
  };
}
