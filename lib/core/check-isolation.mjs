import { mkdtempSync, mkdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, writeFileSync, rmSync, chmodSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { repoFiles, inside } from './files.mjs';
import { execute } from './providers.mjs';

const runner = fileURLToPath(new URL('./check-runner.py', import.meta.url));
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;

export function validateCheckIsolation(config, platform = process.platform) {
  const value = config.checkIsolation;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['backend', 'distribution'].includes(key)) ||
      value.backend !== 'bubblewrap') throw new Error('Invalid checkIsolation configuration; expected the bubblewrap backend.');
  if (!['linux', 'win32'].includes(platform)) throw new Error('checkIsolation requires Linux or Windows with WSL2.');
  if (platform === 'win32' && (typeof value.distribution !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.distribution)))
    throw new Error('checkIsolation requires an explicit WSL distribution name.');
  if (platform === 'linux' && value.distribution !== undefined) throw new Error('checkIsolation.distribution is only valid on Windows.');
  return value;
}

// Never mount the live checkout: ignored files, Git and scheduler state must not
// become readable just because a generated check knows their names.
export function checkSnapshot(root) {
  const parent = mkdtempSync(join(tmpdir(), 'forja-check-'));
  const workspace = join(parent, 'workspace');
  const cleanup = () => {
    const base = resolve(tmpdir());
    if (dirname(resolve(parent)) !== base || !relative(base, parent).startsWith('forja-check-')) throw new Error('Unsafe check snapshot cleanup.');
    rmSync(parent, { recursive: true, force: true });
  };
  try {
    mkdirSync(workspace);
    const hash = createHash('sha256');
    let bytes = 0, files = 0;
    for (const path of repoFiles(root)) {
      const parts = path.split('/');
      if (parts.some(part => ['.git', '.forja'].includes(part.toLowerCase()))) continue;
      if (parts.some(part => !part || /[. ]$/.test(part) || /[\\:\x00-\x1f]/.test(part))) throw new Error('Unsupported path in isolated check snapshot.');
      const source = inside(root, path);
      let ancestor = root;
      for (const part of parts) {
        ancestor = join(ancestor, part);
        try {
          if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Isolated checks refuse symbolic links and junctions.');
        } catch (error) {
          if (error.code === 'ENOENT' && ancestor === source) break;
          throw error;
        }
      }
      let stat;
      try { stat = lstatSync(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile()) throw new Error('Isolated checks require regular project files.');
      if (++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES) throw new Error('Isolated check snapshot exceeds 10000 files or 64 MiB.');
      let content, fd;
      try {
        fd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const before = fstatSync(fd);
        if (!before.isFile() || before.size !== stat.size || before.ino !== stat.ino) throw new Error('Project changed while preparing isolated checks.');
        content = Buffer.alloc(stat.size);
        let read = 0, count;
        while (read < content.length && (count = readSync(fd, content, read, content.length - read, null))) read += count;
        const after = fstatSync(fd);
        if (read !== stat.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
          throw new Error('Project changed while preparing isolated checks.');
      } finally { if (fd !== undefined) closeSync(fd); }
      const target = join(workspace, ...parts);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
      // Copy bytes, never hardlinks. Preserve executable intent on native Linux.
      if (process.platform === 'linux') chmodSync(target, stat.mode & 0o111 ? 0o700 : 0o600);
      hash.update(JSON.stringify([path, content.length, !!(stat.mode & 0o111)]) + '\n').update(content);
    }
    return { workspace, cleanup, manifest: { sha256: hash.digest('hex'), files, bytes } };
  } catch (error) { cleanup(); throw error; }
}

async function launcher(config) {
  const isolation = validateCheckIsolation(config);
  if (!isolation) throw new Error('Isolated check runner requires checkIsolation configuration.');
  if (process.platform === 'linux') return { command: '/usr/bin/python3', args: ['-I', '-B', runner], convert: async path => resolve(path) };
  const base = ['--distribution', isolation.distribution, '--cd', '/', '--exec'];
  const convert = async path => {
    const result = await execute('wsl.exe', [...base, '/usr/bin/wslpath', '-a', '-u', resolve(path)], { timeoutMs: 15000, maxBytes: 8192 });
    const value = result.stdout?.trim();
    if (result.code !== 0 || result.timedOut || result.overflow || !value?.startsWith('/') || /[\r\n\0]/.test(value)) throw new Error('Cannot resolve the isolated check path in WSL.');
    return value;
  };
  return { command: 'wsl.exe', args: [...base, '/usr/bin/python3', '-I', '-B', await convert(runner)], convert };
}

async function invoke(launch, payload, { onLaunch = () => {} } = {}) {
  const outer = await execute(launch.command, launch.args, {
    input: JSON.stringify(payload), timeoutMs: payload.timeout_ms + 15000,
    maxBytes: 24 * 1024 * 1024, onLaunch,
  });
  if (outer.code !== 0 || outer.timedOut || outer.overflow) throw new Error('Isolated check supervisor failed; no host fallback. Verify Python 3, bubblewrap and namespace support.');
  let result;
  try { result = JSON.parse(outer.stdout); } catch { throw new Error('Invalid isolated check supervisor response.'); }
  if (result.version !== 1 || !Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
      typeof result.timedOut !== 'boolean' || typeof result.overflow !== 'boolean') throw new Error('Invalid isolated check supervisor result.');
  return result;
}

export async function preflightCheckIsolation(config, options = {}) {
  if (!validateCheckIsolation(config)) return;
  const launch = await launcher(config);
  const result = await invoke(launch, { command: '/usr/bin/true', args: [], snapshot: null, timeout_ms: 10000 }, options);
  if (result.code !== 0 || result.timedOut || result.overflow) throw new Error('Isolated checks unavailable: bubblewrap must support user, PID and network namespaces. No host fallback.');
}

export async function isolatedCheck(command, args, { cwd, config, timeoutMs = 600000, onLaunch } = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid isolated check command or timeout.');
  const launch = await launcher(config);
  const copy = checkSnapshot(cwd);
  try {
    const result = await invoke(launch, { command, args, snapshot: await launch.convert(copy.workspace), timeout_ms: timeoutMs }, { onLaunch });
    return { ...result, isolation: { backend: 'bubblewrap', snapshot: copy.manifest, network: false, source: 'read-only', timeout_ms: timeoutMs } };
  } finally { copy.cleanup(); }
}
