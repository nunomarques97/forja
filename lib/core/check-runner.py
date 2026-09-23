"""Trusted Linux supervisor for the optional controller-check sandbox.

No project code is imported here. stdout contains one supervisor-owned result;
untrusted stdout/stderr are data fields, never a control protocol.
"""
import json
import math
import os
import resource
import selectors
import signal
import subprocess
import sys
import time

OUTPUT_LIMIT = 8 * 1024 * 1024


def inside():
    timeout_ms = int(sys.argv[2])
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (math.ceil(timeout_ms / 1000) + 1,) * 2)
    os.execvpe(sys.argv[3], sys.argv[3:], dict(os.environ))


def supervise():
    payload = json.load(sys.stdin)
    timeout_ms = payload['timeout_ms']
    snapshot = payload['snapshot']
    args = ['/usr/bin/bwrap', '--unshare-all', '--unshare-user', '--die-with-parent', '--new-session',
            '--disable-userns', '--assert-userns-disabled', '--cap-drop', 'ALL',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
            '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--proc', '/proc', '--dev', '/dev', '--remount-ro', '/dev',
            '--size', '67108864', '--tmpfs', '/tmp',
            '--dir', '/home', '--symlink', '/tmp', '/home/check',
            '--ro-bind', os.path.realpath(__file__), '/runner.py']
    if snapshot is None:
        args += ['--dir', '/workspace']
    else:
        args += ['--ro-bind', snapshot, '/workspace']
    args += ['--chdir', '/workspace', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
             '--setenv', 'HOME', '/home/check', '--setenv', 'TMPDIR', '/tmp',
             '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp',
             '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1',
             '--remount-ro', '/',
             '/usr/bin/python3', '-I', '-B', '/runner.py', '--exec', str(timeout_ms),
             payload['command'], *payload['args']]
    started = time.monotonic()
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    timed_out = overflow = False
    size = 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
            selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
            while selector.get_map() or child.poll() is None:
                # JSON whitespace doubles as a liveness probe of the transport.
                # A disconnected WSL client must not leave the sandbox running.
                os.write(sys.stdout.fileno(), b' ')
                if time.monotonic() - started >= timeout_ms / 1000:
                    timed_out = True
                    break
                for key, _ in selector.select(0.05):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    size += len(chunk)
                    if size > OUTPUT_LIMIT:
                        overflow = True
                        break
                    output[key.data].extend(chunk)
                if overflow:
                    break
    finally:
        # Also runs on a broken WSL pipe or unexpected supervisor error.
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait(timeout=5)
        child.stdout.close()
        child.stderr.close()
    print(json.dumps({'version': 1, 'code': child.returncode,
                      'stdout': output['stdout'].decode('utf-8', errors='replace'),
                      'stderr': output['stderr'].decode('utf-8', errors='replace'),
                      'timedOut': timed_out, 'overflow': overflow,
                      'duration_ms': round((time.monotonic() - started) * 1000)}, ensure_ascii=False))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--exec':
        inside()
    else:
        supervise()
