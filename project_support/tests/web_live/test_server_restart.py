import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

import psutil
import pytest
from user_application.apps.web_dashboard import server_restart as restart


class Process:
    pid = 987654
    def __init__(self, root, command=None):
        self.root = root
        self.command = command or ['python.exe', '-m', restart.MODULE]
        self.killed = False
    def cmdline(self): return self.command
    def exe(self): return 'python.exe'
    def cwd(self): return str(self.root)
    def is_running(self): return True
    def kill(self): self.killed = True
    def wait(self, timeout): return 0


def test_exact_module_and_checkout_required(tmp_path):
    assert restart.is_our_server(Process(tmp_path), tmp_path)
    assert not restart.is_our_server(Process(tmp_path / 'other'), tmp_path)
    assert not restart.is_our_server(Process(tmp_path, ['python.exe', '-m', 'http.server', restart.MODULE]), tmp_path)
    process = Process(tmp_path)
    process.pid = os.getpid()
    assert not restart.is_our_server(process, tmp_path)


def test_mixed_listener_never_partially_kills(tmp_path, monkeypatch):
    own, other = Process(tmp_path), Process(tmp_path / 'other')
    monkeypatch.setattr(restart, 'listeners', lambda *a: [own, other])
    with pytest.raises(RuntimeError, match='다른 프로그램'):
        restart.restart_existing(tmp_path, 8766, '0.0.0.0')
    assert not own.killed and not other.killed


def test_force_only_after_cooperative_timeout_and_identity_recheck(tmp_path, monkeypatch):
    process = Process(tmp_path)
    queries = iter([[process], []])
    monkeypatch.setattr(restart, 'listeners', lambda *a: next(queries))
    monkeypatch.setattr(restart, 'request_shutdown', lambda *a: True)
    waits = []
    def wait(timeout):
        waits.append(timeout)
        if len(waits) == 1: raise psutil.TimeoutExpired(timeout)
    process.wait = wait
    assert restart.restart_existing(tmp_path, 8766, '127.0.0.1', timeout=.1) == 1
    assert process.killed and waits == [.1, 5]


@pytest.mark.parametrize('argv,expected', [([], ['--restart']), (['--port','8767'], ['--restart','--port','8767']), (['--reuse'], ['--reuse'])])
def test_root_entry_defaults_to_restart(monkeypatch, argv, expected):
    spec = importlib.util.spec_from_file_location('entry_test', Path('main.py').resolve())
    entry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entry)
    commands = []
    monkeypatch.setattr(sys, 'argv', ['main.py', *argv])
    monkeypatch.setattr(entry.subprocess, 'call', lambda command, **kw: commands.append(command) or 0)
    assert entry.main() == 0
    assert commands[0][3:] == expected


@pytest.mark.parametrize('cooperative', [True, False])
def test_real_local_listener_restarts_without_touching_other_checkout(tmp_path, cooperative):
    # A temporary, exact-name launcher binds an ephemeral port without API collectors.
    folder = tmp_path / 'user_application/apps/web_dashboard'
    folder.mkdir(parents=True)
    module_path = Path(restart.__file__).resolve()
    script = f'''import importlib.util, socket, time
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('restart', {str(module_path)!r})
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
s=socket.socket();s.bind(('127.0.0.1',0));s.listen()
state=SimpleNamespace(should_exit=False)
close=r.watch_shutdown(state,Path.cwd()) if {cooperative!r} else lambda:None
Path('port.txt').write_text(str(s.getsockname()[1]))
try:
 while not state.should_exit:time.sleep(.02)
finally:
 s.close();close()
'''
    (folder / 'launcher.py').write_text(script, encoding='utf-8')
    process = subprocess.Popen([sys.executable, '-m', restart.MODULE], cwd=tmp_path,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        deadline = time.monotonic() + 8
        while not (tmp_path / 'port.txt').exists() and time.monotonic() < deadline:
            assert process.poll() is None
            time.sleep(.05)
        port = int((tmp_path / 'port.txt').read_text())
        with pytest.raises(RuntimeError, match='다른 폴더'):
            restart.restart_existing(tmp_path / 'different', port, '127.0.0.1')
        assert process.poll() is None
        assert restart.restart_existing(tmp_path, port, '127.0.0.1', timeout=2) == 1
        process.wait(timeout=5)
        if cooperative:
            assert process.returncode == 0
        assert not restart.listeners(port, '127.0.0.1')
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
