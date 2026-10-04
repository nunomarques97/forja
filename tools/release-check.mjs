// Inspect Git's index, never unstaged personal work. No model or network calls.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function privatePath(path) {
  const p = path.replaceAll('\\', '/').toLowerCase();
  if (/^(?:data|\.forja|\.benchmark)\//.test(p)) return true;
  if (/^docs\/forja\//.test(p) && !['docs/forja/core-conventions.md', 'docs/forja/knowledge.json'].includes(p)) return true;
  if (/^docs\/(?:next-|continuation-|core-benchmark\.|core-validation\.|context-economics\.|github-research\.|knowledge-context\.|benchmarks\/)/.test(p)) return true;
  if (/^tools\/(?:benchmarks\/|audit-|benchmark-core\.|dogfood-)/.test(p)) return true;
  return /(?:^|\/)(?:\.env(?:\..*)?|credentials\.json|.*\.(?:pem|key|keystore|jks)|(?:conversation|transcript|chat-history|sponsor-queue|handover|session-log)(?:[.-].*)?)$/.test(p)
    && !/^test\/[^/]+\.test\.mjs$/.test(p);
}

// Reviewed synthetic regression assets, not captured user conversations:
// path -> { sha256, reason, note }. Approval is bound to the staged bytes AND
// finding category. Editing an asset requires fresh review; other findings
// (especially credentials) remain fatal. Empty since 0.22.0: both reviewed
// assets belonged to removed legacy tests.
const REVIEWED_FIXTURES = {};
export function reviewedFixture(path, bytes, reason, table = REVIEWED_FIXTURES) {
  const approved = Object.hasOwn(table, path) ? table[path] : undefined;
  return approved?.reason === reason && createHash('sha256').update(bytes).digest('hex') === approved.sha256
    ? approved.note : null;
}

// Home directories only as filesystem paths. The Windows drive form is
// case-insensitive and accepts JSON-escaped backslashes. The macOS and Linux
// forms are case-sensitive and must start a path, so URL and route segments
// (a host, version or other character before the slash) are not flagged.
const WINDOWS_HOME = /(?<![A-Za-z0-9])[A-Z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\s"'`<>\\/]/i;
const UNIX_HOME = /(?<=^|[\s"'`=(:,;[{<>|]|file:\/\/)\/(?:Users|home)\/[A-Za-z0-9_][A-Za-z0-9._-]*\//;

// Each detector reports the line of its first match, never the matched text.
const DETECTORS = [
  ['private key', [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]],
  ['credential-like value', [/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/]],
  ['personal home path', [WINDOWS_HOME, UNIX_HOME]],
  ['possible conversation export', [/\.codex[\\/]attachments[\\/]|"(?:role|type)"\s*:\s*"(?:user|assistant)"\s*,\s*"(?:content|message)"/i]],
];
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

export function contentFindingLines(buffer) {
  if (buffer.includes(0)) return []; // Binary assets still need human review.
  const text = buffer.toString('utf8');
  const findings = [];
  for (const [reason, patterns] of DETECTORS) {
    const at = patterns.map(pattern => pattern.exec(text)?.index).filter(index => index !== undefined);
    if (at.length) findings.push({ reason, line: lineAt(text, Math.min(...at)) });
  }
  return findings;
}
export function contentFindings(buffer) {
  return contentFindingLines(buffer).map(finding => finding.reason);
}

// .env.example, .env.sample and .env.template document variable names. They
// pass only when every non-comment, non-blank line is KEY= with an empty value
// or an obvious placeholder; any other .env name stays refused by path.
export const envTemplatePath = path => /(?:^|\/)\.env\.(?:example|sample|template)$/i.test(path.replaceAll('\\', '/'));
const PLACEHOLDER = /^(?:|<[A-Za-z _-]{1,40}>|\.{3}|x{3,}|\*{3,}|(?:your|my)(?:[-_][a-z]{1,12}){1,5}|change[-_]?me|replace[-_]?me|placeholder|example|todo|tbd)$/i;
// Returns the first line that is not a placeholder assignment, or null.
export function envTemplateProblem(buffer) {
  if (buffer.includes(0)) return 1;
  const lines = buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=(.*)$/.exec(line);
    // A comment needs whitespace before #, so KEY=#value stays a value.
    const value = match?.[1].replace(/\s+#.*$/, '').trim();
    const unquoted = value && /^(["'])(.*)\1$/.exec(value)?.[2];
    if (value === undefined || !PLACEHOLDER.test(unquoted ?? value)) return index + 1;
  }
  return null;
}

// All findings for one file: { reason, line }, line null for a path finding.
export function fileFindings(path, bytes) {
  const findings = [];
  if (privatePath(path)) {
    const line = envTemplatePath(path) ? envTemplateProblem(bytes) : null;
    if (!envTemplatePath(path) || line !== null) findings.push({ reason: 'private execution/research/credential path', line });
  }
  return [...findings, ...contentFindingLines(bytes)];
}
export const findingLabel = finding => `${finding.path}${finding.line ? ':' + finding.line : ''} ${finding.reason}`;

export function inspectIndex(root, { tree = false } = {}) {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const names = git(tree ? ['ls-files', '-z'] : ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  const findings = [];
  const reviewed = [];
  for (const path of names) {
    const bytes = git(['show', `:${path}`]);
    for (const { reason, line } of fileFindings(path, bytes)) {
      const note = reviewedFixture(path, bytes, reason);
      if (note) reviewed.push({ path, reason, note });
      else findings.push({ path, reason, line });
    }
  }
  return { scope: tree ? 'tracked index snapshot; history NOT scanned' : 'staged additions/modifications', files: names.length, findings, reviewed };
}

// Report-only scan of a committed tree (the run base) before any session, so
// findings that already exist are known up front. Files above MAX_SCAN_BYTES
// are counted as skipped; delivery still scans every file it stages.
const MAX_SCAN_BYTES = 1024 * 1024;
export const BASE_FINDINGS_SHOWN = 50;
export function scanTree(root, rev) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.GIT_OPTIONAL_LOCKS = '0';
  const git = (args, input) => execFileSync('git', ['--no-pager', ...args], { cwd: root, env, input, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  const entries = git(['ls-tree', '-r', '-l', '-z', rev]).toString('utf8').split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t'), [mode, type, id, size] = entry.slice(0, tab).split(/\s+/);
    return { path: entry.slice(tab + 1), mode, type, id, size: Number(size) };
  });
  const files = entries.filter(e => e.type === 'blob' && ['100644', '100755'].includes(e.mode));
  const scanned = files.filter(e => e.size <= MAX_SCAN_BYTES);
  const findings = [], reviewed = [];
  for (let start = 0; start < scanned.length;) {
    let end = start, total = 0;
    while (end < scanned.length && (end === start || total + scanned[end].size <= 16 * MAX_SCAN_BYTES)) total += scanned[end++].size;
    const batch = scanned.slice(start, end), out = git(['cat-file', '--batch'], batch.map(e => e.id).join('\n') + '\n');
    let at = 0;
    for (const entry of batch) {
      const header = out.indexOf(10, at), size = Number(out.toString('utf8', at, header).split(' ')[2]);
      const bytes = out.subarray(header + 1, header + 1 + size);
      at = header + 2 + size;
      for (const { reason, line } of fileFindings(entry.path, bytes)) {
        const note = reviewedFixture(entry.path, bytes, reason);
        if (note) reviewed.push({ path: entry.path, reason, note });
        else findings.push({ path: entry.path, reason, line });
      }
    }
    start = end;
  }
  return { files: files.length, skipped: files.length - scanned.length, findings, reviewed };
}
// Compact form kept in run state and printed by start and doctor.
export function baseScanReport(root, rev) {
  const { files, skipped, findings } = scanTree(root, rev);
  return { files, skipped, findings_total: findings.length, findings: findings.slice(0, BASE_FINDINGS_SHOWN) };
}
export function baseScanNotice(report) {
  if (report.error) return `The privacy pre-scan of the run base could not run (${report.error}); delivery still scans every staged file.`;
  if (!report.findings_total) return `The privacy pre-scan found nothing in ${report.files} tracked file(s) of the run base${report.skipped ? ` (${report.skipped} file(s) over 1 MiB not pre-scanned)` : ''}.`;
  const shown = report.findings.slice(0, 5).map(findingLabel).join('; ');
  return `The run base already has ${report.findings_total} privacy-scan finding(s): ${shown}${report.findings_total > 5 ? '; ...' : ''}. They are reported, not approved: delivery of a task that changes one of these files still blocks for inspection. Fix them in a separate commit before starting, or expect that inspection.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = inspectIndex(process.cwd(), { tree: process.argv.includes('--tree') });
    console.log(JSON.stringify(result, null, 2));
    for (const finding of result.findings) console.error(findingLabel(finding));
    if (result.findings.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
