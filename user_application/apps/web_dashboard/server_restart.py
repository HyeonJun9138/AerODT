"""Local launcher lifecycle. Never terminate a process based only on a port."""
import ctypes
import hashlib
import os
from pathlib import Path
import socket
import threading

import psutil

MODULE = 'user_application.apps.web_dashboard.launcher'


def is_our_server(process, root):
    """Exact Python module AND checkout directory; unreadable identity is refused."""
    try:
        command = process.cmdline()
        return (process.pid != os.getpid()
                and Path(process.exe()).name.lower() in ('python.exe', 'pythonw.exe', 'python', 'python3')
                and len(command) >= 3 and command[1:3] == ['-m', MODULE]
                and Path(process.cwd()).resolve() == Path(root).resolve())
    except (psutil.Error, OSError):
        return False


def listeners(port, host):
    addresses = None if host in ('0.0.0.0', '::', '*') else {
        item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)}
    found = set()
    for connection in psutil.net_connections(kind='tcp'):
        if connection.status != psutil.CONN_LISTEN or connection.laddr.port != port:
            continue
        if addresses is not None and connection.laddr.ip not in addresses | {'0.0.0.0', '::'}:
            continue
        if connection.pid is None:
            raise RuntimeError('포트 소유 프로세스를 확인할 수 없어 종료하지 않습니다.')
        found.add(connection.pid)
    return [psutil.Process(pid) for pid in sorted(found)]


def _event_name(process, root):
    identity = f'{Path(root).resolve()}:{process.pid}:{process.create_time():.6f}'
    return 'Local\\AeroDT-stop-' + hashlib.sha256(identity.encode()).hexdigest()


def _kernel():
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateEventW.restype = wintypes.HANDLE
    kernel.OpenEventW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.OpenEventW.restype = wintypes.HANDLE
    kernel.SetEvent.argtypes = [wintypes.HANDLE]
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    return kernel


def watch_shutdown(server, root):
    """Windows local event, not an unauthenticated HTTP shutdown endpoint."""
    if os.name != 'nt':
        return lambda: None
    kernel = _kernel()
    handle = kernel.CreateEventW(None, True, False, _event_name(psutil.Process(), root))
    if not handle:
        raise OSError(ctypes.get_last_error(), 'AeroDT 종료 이벤트를 만들 수 없습니다.')
    stopped = threading.Event()

    def watch():
        while not stopped.is_set():
            if kernel.WaitForSingleObject(handle, 100) == 0:
                if not stopped.is_set():
                    server.should_exit = True
                return

    thread = threading.Thread(target=watch, daemon=True)
    thread.start()

    def close():
        stopped.set()
        kernel.SetEvent(handle)
        thread.join()
        kernel.CloseHandle(handle)

    return close


def request_shutdown(process, root):
    if os.name != 'nt':
        process.terminate()  # SIGTERM is handled by uvicorn on POSIX.
        return True
    kernel = _kernel()
    handle = kernel.OpenEventW(2, False, _event_name(process, root))  # EVENT_MODIFY_STATE
    if not handle:
        return False  # Old launcher has no cooperative shutdown event.
    try:
        return bool(kernel.SetEvent(handle))
    finally:
        kernel.CloseHandle(handle)


def restart_existing(root, port, host, timeout=10.0):
    candidates = listeners(port, host)
    # Check EVERY listener before changing any process, including IPv4/IPv6.
    if any(not is_our_server(process, root) for process in candidates):
        raise RuntimeError(f'포트 {port}가 다른 프로그램 또는 다른 폴더의 서버에 속합니다. 종료하지 않습니다.')
    for process in candidates:
        try:
            if not process.is_running():
                continue
            if not is_our_server(process, root):
                raise RuntimeError('프로세스 식별 정보가 변경되어 종료를 취소합니다.')
            print(f'기존 AeroDT 서버 종료 중 (PID {process.pid})...', flush=True)
            graceful = request_shutdown(process, root)
            if graceful:
                try:
                    process.wait(timeout=timeout)
                    print('기존 AeroDT 서버 정상 종료.', flush=True)
                    continue
                except psutil.TimeoutExpired:
                    pass
            if not process.is_running():
                continue
            if not is_our_server(process, root):
                raise RuntimeError('프로세스 식별 정보가 변경되어 강제 종료를 취소합니다.')
            print('정상 종료 미지원 또는 시간 초과: 확인된 AeroDT 서버만 강제 종료합니다.', flush=True)
            process.kill()  # psutil checks PID reuse; never kill a process tree.
            process.wait(timeout=5)
        except psutil.NoSuchProcess:
            pass
    if listeners(port, host):
        raise RuntimeError(f'포트 {port}가 아직 사용 중입니다. 새 서버를 시작하지 않습니다.')
    return len(candidates)
