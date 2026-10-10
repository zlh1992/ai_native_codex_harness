#!/usr/bin/env python3
"""Manage a detached process without trusting a recycled PID."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def identity(pid):
    if not isinstance(pid, int) or pid <= 1:
        return None
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'uid=,lstart=,command='],
                            capture_output=True, text=True, check=False)
    value = result.stdout.strip()
    if result.returncode or not value:
        return None
    return value


def main():
    action, record_name = sys.argv[1:3]
    record = Path(record_name)
    record.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077)
    with open(str(record) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(record.read_text()) if record.exists() else None
        live = identity(state.get('pid')) if state else None
        if live and live != state.get('identity'):
            raise RuntimeError('PID identity changed; refusing to control another process')
        if action == 'status':
            if not live:
                return 1
            print(state['pid'])
            return 0
        if action == 'stop':
            if live:
                os.kill(state['pid'], 15)
                deadline = time.monotonic() + 15
                while identity(state['pid']) == live and time.monotonic() < deadline:
                    time.sleep(0.1)
                if identity(state['pid']) == live:
                    raise RuntimeError('Process did not stop; state retained')
            record.unlink(missing_ok=True)
            return 0
        if action != 'start':
            raise RuntimeError('Expected start, stop or status')
        if live:
            print(state['pid'])
            return 0
        cwd, log_file, *command = sys.argv[3:]
        if not command or not Path(command[0]).is_absolute():
            raise RuntimeError('An absolute executable is required')
        with open(log_file, 'ab') as log:
            os.chmod(log_file, 0o600)
            process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, start_new_session=True)
        live = identity(process.pid)
        if not live:
            raise RuntimeError('Process exited before registration')
        temp = record.with_suffix('.tmp')
        temp.write_text(json.dumps({'pid': process.pid, 'identity': live}) + '\n')
        temp.replace(record)
        print(process.pid)
        return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Never print argv, the subprocess environment, or credentials.
        print(f'Process control failed: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
