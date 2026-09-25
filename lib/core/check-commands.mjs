// Checks are argv launched without a shell. On Windows, Node can only spawn
// .exe/.com files directly, so a .cmd/.bat shim (npx, pnpm, yarn, tsc, ...)
// fails with ENOENT or EINVAL and would be recorded as a failed validation.
// A command that resolves nowhere fails the same way on every platform. FORJA
// refuses such checks before any task instead of spending developer sessions.
// node and npm are mapped to the running Node executable.
import { statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

export const WINDOWS_CHECK_GUIDANCE = ' This host runs checks on Windows without a shell: a check command must be node, npm or a real .exe; .cmd/.bat shims such as npx, pnpm, yarn or tsc cannot be launched. Use node with the tool JavaScript entry (for example node node_modules/typescript/bin/tsc) or npm with a package script.';

const isFile = path => {
  try { return statSync(path).isFile(); } catch { return false; }
};
const pathDirs = (env, platform = 'win32') => {
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH');
  return (key ? env[key] : '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
};

// npm on Windows is itself a .cmd shim; checks run its JavaScript entry with
// node. Installers put it next to node.exe; version managers next to npm.cmd.
export function npmCli({ execPath = process.execPath, env = process.env, exists = isFile } = {}) {
  const dirs = [dirname(execPath), ...pathDirs(env).filter(dir => exists(join(dir, 'npm.cmd')))];
  return dirs.map(dir => join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(exists) || null;
}

// Returns an actionable message for a check the host cannot launch, or null:
// a Windows .cmd/.bat shim, or an executable that resolves nowhere. A missing
// explicit path is accepted when a task's files scope covers it, because an
// earlier task may create it (for example a virtual environment).
export function checkLaunchProblem(check, label, { platform = process.platform, env = process.env, cwd = process.cwd(), execPath = process.execPath, exists = isFile, tasks = [] } = {}) {
  if (!check || typeof check.command !== 'string') return null;
  const { command } = check;
  const windows = platform === 'win32';
  if (command === 'node' || (command === 'npm' && !windows)) return null;
  if (command === 'npm')
    return npmCli({ execPath, env, exists }) ? null : `${label} uses npm, but npm-cli.js was found neither next to the running node nor next to an npm.cmd on PATH. Install npm with Node or use node with a JavaScript entry.`;
  const shim = `${label} command is a .cmd/.bat shim on Windows (such as npx, pnpm, yarn or tsc); checks run without a shell and cannot launch it. Use node with the tool JavaScript entry (for example node node_modules/typescript/bin/tsc) or npm with a package script.`;
  if (windows && /\.(cmd|bat)$/i.test(command)) return shim;
  // Like Node: an explicit path, or on Windows the working directory then PATH
  // (trying .com and .exe without an extension), elsewhere PATH only.
  const explicit = /[\\/]/.test(command) || (windows && /^[a-z]:/i.test(command));
  const dirs = explicit ? [dirname(resolve(cwd, command))] : [...(windows ? [cwd] : []), ...pathDirs(env, platform)];
  const name = explicit ? basename(resolve(cwd, command)) : command;
  const extensions = windows && !/\.[^\\/.]+$/.test(name) ? ['.com', '.exe'] : [''];
  for (const dir of dirs) {
    if (extensions.some(ext => exists(join(dir, name + ext)))) return null;
    if (windows && extensions[0] && ['.cmd', '.bat'].some(ext => exists(join(dir, name + ext)))) return shim;
  }
  if (explicit && createdByTask(relative(cwd, resolve(cwd, command)), tasks)) return null;
  return explicit
    ? `${label} command ${JSON.stringify(command)} does not exist relative to the project root, and no task files scope covers it. Correct the path (keep its separators) or add it to the files of the task that creates it.`
    : `${label} command ${JSON.stringify(command)} was not found on PATH${windows ? ' or in the project root' : ''}. Correct the command, write a path with separators, or install the tool before starting.`;
}

function createdByTask(path, tasks) {
  const target = path.replaceAll('\\', '/');
  if (target.startsWith('../')) return false;
  return tasks.some(t => (t.files || []).some(file => {
    const scope = String(file).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return !scope || scope === '.' || target === scope || target.startsWith(`${scope}/`);
  }));
}

// Every task check and final check of a run that uses host checks.
export function checkCommandProblem(tasks = [], config = {}, options = {}) {
  if (config.checkIsolation) return null;
  const context = { ...options, tasks };
  for (const t of tasks)
    for (let i = 0; i < (t.checks || []).length; i++) {
      const problem = checkLaunchProblem(t.checks[i], `Task ${t.id} checks[${i}]`, context);
      if (problem) return problem;
    }
  for (let i = 0; i < (config.finalChecks || []).length; i++) {
    const problem = checkLaunchProblem(config.finalChecks[i], `finalChecks[${i}]`, context);
    if (problem) return problem;
  }
  return null;
}
