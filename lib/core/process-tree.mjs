import { spawn, spawnSync } from 'node:child_process';

// Cleanup of the process tree that execute() spawned. Only processes proven to
// descend from the spawned PID are terminated: on POSIX the spawned process
// group, on Windows the spawned PID and the descendants recorded while it ran
// (PID, parent PID and creation time from a CIM process snapshot), so orphans
// whose parent already exited are still included. PID reuse is never followed:
// a process counts only when it was created while its recorded parent lived.
export const PROCESS_POLL_MS = 3000;
export const PROCESS_GRACE_MS = 1000;
const RESPONSE_MS = 30000;
const ROUNDS = 2;
const SURVIVOR_LIMIT = 50;

const bounded = (value, min, max, fallback) => Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = error => String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300);

// CIM datetime: yyyymmddHHMMSS.ffffff followed by the UTC offset in minutes.
export function cimTime(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(value || '');
  if (!m) return null;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], Math.floor(+m[7] / 1000));
  return local - (m[8] === '-' ? -1 : 1) * Number(m[9]) * 60000;
}

// Pure tracking state, separate from the snapshot transport so PID reuse can be
// tested with synthetic snapshots. spawnedAt is taken right after spawn()
// returned, so the root was created no later than spawnedAt.
export function treeTracker(rootPid, spawnedAt) {
  // key `${pid} ${created}` -> { pid, ppid, created, key, at, seen }
  const nodes = new Map();
  // The open child handle keeps the root PID reserved until its exit event, so
  // the root lives at least until `until`.
  const root = { pid: rootPid, key: null, at: spawnedAt, until: Infinity };
  let live = [];
  // A tracked process is only proven alive at the start of the last snapshot
  // that contained it (`seen`): its PID may be reused at any later moment, so a
  // child counts only when created strictly before that. Kernel creation times
  // and the snapshot clock share the system tick, which keeps the comparison
  // conservative. Before the root is identified, its children must be created
  // after spawnedAt, which excludes children of a previous holder of its PID.
  const parentOf = proc => {
    if (proc.ppid === root.pid && proc.key !== root.key && proc.at <= root.until && (root.key ? proc.at >= root.at : proc.at > root.at)) return root;
    for (const node of nodes.values())
      if (node.pid === proc.ppid && proc.at >= node.at && proc.at < node.seen) return node;
    return null;
  };
  return {
    root,
    nodes,
    exited(at) { root.until = Math.min(root.until, at); },
    // Descendants present in the last successful snapshot.
    known: () => live.slice(),
    // procs: [{ pid, ppid, created }] from one snapshot; startedAt: when the
    // snapshot began, before any process was listed.
    observe(procs, startedAt) {
      const list = procs.map(p => ({ ...p, key: `${p.pid} ${p.created}`, at: cimTime(p.created) }))
        .filter(p => Number.isSafeInteger(p.pid) && Number.isSafeInteger(p.ppid) && p.at !== null);
      // Only the root can hold its PID with a creation time up to spawnedAt
      // in a snapshot taken after the spawn; a later reuser is created after.
      if (!root.key) {
        const own = list.find(p => p.pid === root.pid && p.at <= spawnedAt);
        if (own) { root.key = own.key; root.at = own.at; }
      }
      for (const p of list) {
        const node = nodes.get(p.key);
        if (node) node.seen = Math.max(node.seen, startedAt);
      }
      let added = true;
      while (added) {
        added = false;
        for (const p of list)
          if (!nodes.has(p.key) && p.key !== root.key && parentOf(p)) {
            nodes.set(p.key, { pid: p.pid, ppid: p.ppid, created: p.created, key: p.key, at: p.at, seen: startedAt });
            added = true;
          }
      }
      live = list.filter(p => nodes.has(p.key)).map(p => ({ pid: p.pid, created: p.created }));
      return live.slice();
    },
  };
}

// One long-lived powershell.exe per execute(): a full snapshot costs about half
// a second of WMI time, so it polls rarely and answers explicit requests.
const WATCHER = `
$ErrorActionPreference = 'Stop'
$poll = __POLL__
$all = New-Object System.Management.ManagementObjectSearcher('SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process')
$out = [Console]::Out
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
function Snap($tag) {
  $sb = New-Object System.Text.StringBuilder
  $start = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach ($p in $all.Get()) { if ($p['CreationDate']) { [void]$sb.Append('P ').Append($p['ProcessId']).Append(' ').Append($p['ParentProcessId']).Append(' ').Append($p['CreationDate']).Append("\`n") } }
  [void]$sb.Append('E ').Append($tag).Append(' ').Append($start).Append("\`n")
  $out.Write($sb.ToString()); $out.Flush()
}
try {
  $pending = $reader.ReadLineAsync()
  Snap 'poll'
  while ($true) {
    if (-not $pending.Wait($poll)) { Snap 'poll'; continue }
    $line = $pending.Result
    if ($line -eq $null -or $line -eq 'exit') { break }
    if ($line -eq 'snap') { Snap 'request' }
    elseif ($line.StartsWith('kill ')) {
      foreach ($target in $line.Substring(5).Split(' ')) {
        $id, $created = $target.Split('/')
        try {
          $p = @((New-Object System.Management.ManagementObjectSearcher("SELECT Handle,ProcessId,CreationDate FROM Win32_Process WHERE ProcessId=$([uint32]$id)")).Get())
          if ($p.Count -ne 1 -or $p[0]['CreationDate'] -ne $created) { $out.WriteLine("K $id gone") }
          else { $code = $p[0].InvokeMethod('Terminate', [object[]]@(1)); $out.WriteLine("K $id $code") }
        } catch { $out.WriteLine("K $id error") }
      }
      $out.WriteLine('K done'); $out.Flush()
    }
    $pending = $reader.ReadLineAsync()
  }
} catch { $out.WriteLine('X ' + ($_.Exception.Message -replace '\\s+', ' ')); $out.Flush() }
`;

function windowsWatcher(rootPid, spawnedAt, { pollMs }) {
  const tracker = treeTracker(rootPid, spawnedAt);
  const script = Buffer.from(WATCHER.replace('__POLL__', String(pollMs)), 'utf16le').toString('base64');
  let link = null, reconnected = false;
  // One watcher process with its own pending requests; a failed link stays
  // failed and is replaced at most once.
  const connect = () => {
    const state = { failure: null, waiters: [], killWaiter: null, killLines: [], procs: [], buffer: '', proc: null };
    const fail = text => {
      state.failure ||= text;
      for (const w of state.waiters.splice(0)) w.reject(new Error(state.failure));
      if (state.killWaiter) { state.killWaiter.reject(new Error(state.failure)); state.killWaiter = null; }
    };
    const line = text => {
      if (text.startsWith('P ')) {
        const [, pid, ppid, created] = text.split(' ');
        state.procs.push({ pid: Number(pid), ppid: Number(ppid), created });
      } else if (text.startsWith('E ')) {
        const [, tag, start] = text.split(' ');
        const startedAt = Number(start);
        const procs = state.procs;
        state.procs = [];
        if (!Number.isSafeInteger(startedAt)) { fail('process snapshot sent no start time'); return; }
        const tracked = tracker.observe(procs, startedAt);
        if (tag === 'request') state.waiters.shift()?.resolve(tracked);
      } else if (text.startsWith('K ')) {
        if (text === 'K done') { state.killWaiter?.resolve(state.killLines); state.killWaiter = null; state.killLines = []; }
        else state.killLines.push(text.slice(2));
      } else if (text.startsWith('X ')) fail(`process snapshot failed: ${text.slice(2)}`);
    };
    try {
      state.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script], {
        // Not detached: a console-less powershell.exe cannot answer. It exits
        // when its stdin closes. An operator's Ctrl+C can end it too; cleanup
        // then starts one replacement.
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
      state.proc.on('error', e => fail(`process snapshot unavailable: ${message(e)}`));
      state.proc.on('exit', () => fail('process snapshot stopped unexpectedly'));
      state.proc.stdin.on('error', () => {});
      state.proc.stdout.setEncoding('utf8').on('data', chunk => {
        state.buffer += chunk;
        let i;
        while ((i = state.buffer.indexOf('\n')) >= 0) { line(state.buffer.slice(0, i).replace(/\r$/, '')); state.buffer = state.buffer.slice(i + 1); }
      });
    } catch (e) { fail(`process snapshot unavailable: ${message(e)}`); }
    state.ask = (command, register) => new Promise((resolve, reject) => {
      if (state.failure) { reject(new Error(state.failure)); return; }
      const timer = setTimeout(() => fail('process snapshot did not answer in time'), RESPONSE_MS);
      register({ resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      state.proc.stdin.write(command + '\n');
    });
    state.close = () => {
      const p = state.proc;
      state.proc = null;
      try { p?.stdin.end('exit\n'); } catch {}
      if (p && p.exitCode === null) setTimeout(() => { if (p.exitCode === null) p.kill(); }, 5000).unref();
    };
    return state;
  };
  link = connect();
  return {
    method: 'process_tree',
    exited: at => tracker.exited(at),
    known: () => tracker.known(),
    // The tracker keeps its proofs across links, so a replacement only adds
    // what its own snapshots prove.
    async snapshot() {
      try { return await link.ask('snap', w => link.waiters.push(w)); }
      catch (e) {
        if (reconnected) throw e;
        reconnected = true;
        link.close();
        link = connect();
        return link.ask('snap', w => link.waiters.push(w));
      }
    },
    kill: targets => link.ask(`kill ${targets.map(t => `${t.pid}/${t.created}`).join(' ')}`, w => { link.killWaiter = w; }),
    close() { link.close(); },
  };
}

// POSIX: the spawned process is a group leader (detached), so its group holds
// every descendant that did not leave it on purpose. A PGID stays reserved
// while the group has members, so signalling it cannot reach another group.
function posixGroup(pgid) {
  const members = () => {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: RESPONSE_MS });
    if (r.error || r.status !== 0) throw new Error(`process listing failed: ${message(r.error || r.stderr || r.status)}`);
    return r.stdout.split('\n').map(l => l.trim().split(/\s+/)).filter(([pid, group, stat]) => Number(group) === pgid && !String(stat).startsWith('Z'))
      .map(([pid]) => ({ pid: Number(pid), created: null }));
  };
  return {
    method: 'process_group',
    exited() {},
    // Without a listing the group is not proven to exist, so it is not signalled;
    // the failure is reported instead.
    snapshot: async () => members(),
    kill: async () => {
      try { process.kill(-pgid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      return [];
    },
    close() {},
  };
}

// Starts tracking right after spawn() returned (spawnedAt must not precede the
// child's creation). options.terminate replaces the real kill
// (tests force a survivor with a no-op).
export function processTree(pid, { spawnedAt = Date.now(), pollMs, graceMs, terminate, platform = process.platform } = {}) {
  const poll = bounded(pollMs, 100, 60000, PROCESS_POLL_MS);
  const grace = bounded(graceMs, 0, 10000, PROCESS_GRACE_MS);
  const source = platform === 'win32' ? windowsWatcher(pid, spawnedAt, { pollMs: poll }) : posixGroup(pid);
  let done = null;
  return {
    exited: (at = Date.now()) => source.exited(at),
    cleanup() {
      done ||= cleanupTree(source, { grace, terminate });
      return done;
    },
  };
}

// Terminates what source reports, in bounded rounds. Never throws: a failed
// snapshot or kill is part of the report.
export async function cleanupTree(source, { grace = PROCESS_GRACE_MS, terminate } = {}) {
  const report = { method: source.method, terminated: [], survivors: [], error: null };
  const attempted = new Set();
  // If no snapshot answers, the descendants last seen alive are reported.
  let targets = source.known?.() ?? [];
  try {
    targets = await source.snapshot();
    for (let round = 0; targets.length && round < ROUNDS; round++) {
      targets.forEach(t => attempted.add(t.pid));
      if (terminate) await terminate(targets.map(t => t.pid));
      else await source.kill(targets);
      await delay(grace);
      targets = await source.snapshot();
    }
  } catch (e) { report.error = message(e); }
  // After a failure the last known descendants may still be running.
  report.survivors = targets.map(t => t.pid).slice(0, SURVIVOR_LIMIT);
  report.terminated = [...attempted].filter(p => !report.survivors.includes(p)).slice(0, SURVIVOR_LIMIT);
  source.close();
  return report;
}

// A short operator-facing sentence; empty when nothing needs attention.
export function processCleanupNote(cleanup) {
  if (!cleanup) return '';
  const survivors = Array.isArray(cleanup.survivors) ? cleanup.survivors.filter(Number.isSafeInteger) : [];
  return [
    survivors.length ? ` Processes started by this session are still running after cleanup (PID ${survivors.join(', ')}); end them by hand if they are not needed.` : '',
    cleanup.error ? ` Process cleanup could not complete: ${cleanup.error}.` : '',
  ].join('');
}
