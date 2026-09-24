// Checks are argv launched without a shell. On Windows, Node can only spawn
// .exe/.com files directly, so a .cmd/.bat shim (npx, pnpm, yarn, tsc, ...)
// fails with ENOENT or EINVAL and would be recorded as a failed validation.
// FORJA refuses such checks before any task instead of running them through a
// shell. node and npm are mapped to the running Node executable.
import { statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const WINDOWS_CHECK_GUIDANCE = ' This host runs checks on Windows without a shell: a check command must be node, npm or a real .exe; .cmd/.bat shims such as npx, pnpm, yarn or tsc cannot be launched. Use node with the tool JavaScript entry (for example node node_modules/typescript/bin/tsc) or npm with a package script.';

const isFile = path => {
  try { return statSync(path).isFile(); } catch { return false; }
};
const pathDirs = env => {
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH');
  return (key ? env[key] : '').split(';').filter(Boolean);
};

// npm on Windows is itself a .cmd shim; checks run its JavaScript entry with
// node. Installers put it next to node.exe; version managers next to npm.cmd.
export function npmCli({ execPath = process.execPath, env = process.env, exists = isFile } = {}) {
  const dirs = [dirname(execPath), ...pathDirs(env).filter(dir => exists(join(dir, 'npm.cmd')))];
  return dirs.map(dir => join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(exists) || null;
}

// Returns an actionable message for a check Windows cannot launch, or null.
export function windowsCheckProblem(check, label, { platform = process.platform, env = process.env, cwd = process.cwd(), execPath = process.execPath, exists = isFile } = {}) {
  if (platform !== 'win32' || !check || typeof check.command !== 'string') return null;
  const { command } = check;
  if (command === 'node') return null;
  if (command === 'npm')
    return npmCli({ execPath, env, exists }) ? null : `${label} uses npm, but npm-cli.js was found neither next to the running node nor next to an npm.cmd on PATH. Install npm with Node or use node with a JavaScript entry.`;
  const shim = `${label} command is a .cmd/.bat shim on Windows (such as npx, pnpm, yarn or tsc); checks run without a shell and cannot launch it. Use node with the tool JavaScript entry (for example node node_modules/typescript/bin/tsc) or npm with a package script.`;
  if (/\.(cmd|bat)$/i.test(command)) return shim;
  if (/\.[^\\/.]+$/.test(command)) return null;
  // Like Node on Windows: an explicit path, or the working directory then PATH,
  // each trying .com and .exe.
  const explicit = /[\\/]/.test(command);
  const dirs = explicit ? [dirname(resolve(cwd, command))] : [cwd, ...pathDirs(env)];
  const name = explicit ? basename(resolve(cwd, command)) : command;
  for (const dir of dirs) {
    if (['.com', '.exe'].some(ext => exists(join(dir, name + ext)))) return null;
    if (['.cmd', '.bat'].some(ext => exists(join(dir, name + ext)))) return shim;
  }
  return null;
}

// Every task check and final check of a run that uses host checks.
export function checkCommandProblem(tasks = [], config = {}, options = {}) {
  if (config.checkIsolation) return null;
  for (const t of tasks)
    for (let i = 0; i < (t.checks || []).length; i++) {
      const problem = windowsCheckProblem(t.checks[i], `Task ${t.id} checks[${i}]`, options);
      if (problem) return problem;
    }
  for (let i = 0; i < (config.finalChecks || []).length; i++) {
    const problem = windowsCheckProblem(config.finalChecks[i], `finalChecks[${i}]`, options);
    if (problem) return problem;
  }
  return null;
}
