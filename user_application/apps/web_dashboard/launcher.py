"""One-command local GUI launch: live CelesTrak and, with local credentials, OpenSky."""
import argparse
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import threading
import webbrowser
from urllib.request import build_opener, ProxyHandler

import uvicorn
import psutil
from data.ingestion.saved_gp import load_saved_gp
from user_application.apps.web_dashboard.application import ROOT, create_app, load_config
from user_application.apps.web_dashboard.credentials import configure_airspace, configure_cesium, configure_opensky, configure_vworld


# Bound to every interface, so the address to hand to somebody else is the one
# this machine answers on. Nothing is sent to the probe address; connecting a
# datagram socket only picks the interface the default route would use.
ANY_HOST = ('0.0.0.0', '::', '*')
LOOPBACK = ('127.0.0.1', 'localhost', '::1')


def configured_host(fallback='127.0.0.1'):
    """The address the deployment config asks for. The config owns it, so
    editing the file is enough; --host overrides it for one run."""
    host = load_config().get('host')
    return host if isinstance(host, str) and host.strip() else fallback


def browse_url(host, port):
    """The address to open here. A server bound to every interface is reached
    over loopback; one bound to a single address is reached at that address."""
    return f'http://{"127.0.0.1" if host in ANY_HOST else host}:{port}/'


def lan_address(port, probe='203.0.113.1'):
    """The URL another machine on the network can open, or None if this one has
    no route out."""
    finder = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        finder.connect((probe, 9))
        return f'http://{finder.getsockname()[0]}:{port}/'
    except OSError:
        return None
    finally:
        finder.close()


def prepare_config(root=ROOT, port=8766, host=None):
    config = load_config()
    # CelesTrak is polled live; the newest saved GP still loads at startup so
    # satellites are on screen before the first response, and the live record
    # replaces it. Aircraft and buildings wait for their credentials below.
    # The host is only overridden when the command line gave one: otherwise the
    # config file's address stands.
    config.update(port=port, celestrak_enabled=True,
                  opensky_enabled=False, buildings_enabled=False, vworld_enabled=False, airspace_enabled=False)
    if host:
        config['host'] = host
    config.setdefault('host', '127.0.0.1')
    directory = root / 'data/workspace/live_ingestion/imports'
    candidates = sorted(directory.glob('*.json.gz'), key=lambda p:p.stat().st_mtime, reverse=True)
    for path in candidates:
        try:
            load_saved_gp(path)
        except (OSError, ValueError, KeyError, TypeError, EOFError):
            continue
        config['saved_satellites'] = str(path)
        break
    if 'saved_satellites' not in config:
        print('저장 위성 자료 없음: 첫 CelesTrak 응답이 도착하면 위성이 표시됩니다.')
    for configure, key, label in ((configure_opensky,'opensky_enabled','항공기'),
                                  (configure_cesium,'buildings_enabled','3D 건물'),
                                  (configure_vworld,'vworld_enabled','브이월드'),
                                  (configure_airspace,'airspace_enabled','공역')):
        try:
            configure()
            config[key] = True
        except ValueError as error:
            print(f'{label}: 로컬 인증정보를 읽지 못했습니다. 해당 연결만 비활성화합니다.')
            print(f'  이유: {error}')
    return config


def server_status(port, host='127.0.0.1'):
    # Asked at the address this run would bind: a dashboard on another address
    # is not this port taken, and one already here is not something to replace.
    reachable = '127.0.0.1' if host in ANY_HOST else host
    try:
        with socket.create_connection((reachable,port),timeout=.5):
            pass
    except OSError:
        return 'free'
    try:
        opener = build_opener(ProxyHandler({}))
        base = f'http://{reachable}:{port}'
        with opener.open(base+'/api/health',timeout=2) as response:
            health = json.loads(response.read(4096))
        with opener.open(base+'/',timeout=2) as response:
            page = response.read(8192).decode('utf-8')
        if health.get('status') == 'ready' and health.get('schema_version') == 1 and any(
                title in page for title in ('AeroDT — Live Earth', 'AERODT — Live Twin')):
            return 'ready'
    except (OSError, ValueError):
        pass
    return 'busy'


def build_parser():
    parser = argparse.ArgumentParser(description='AeroDT GUI 실행: 저장 위성 + 인증된 항공기/건물')
    parser.add_argument('--port',type=int,default=8766)
    parser.add_argument('--host',default=None,
                        help='서버가 응답할 주소. 없으면 설정 파일(user_application/configs/web_dashboard/'
                             'default.json)의 host. 0.0.0.0이면 모든 인터페이스')
    parser.add_argument('--no-browser',action='store_true',help='자동 브라우저 열기 생략')
    lifecycle = parser.add_mutually_exclusive_group()
    lifecycle.add_argument('--restart', action='store_true', help='같은 폴더의 기존 AeroDT 서버만 종료 후 재시작')
    lifecycle.add_argument('--reuse', dest='restart', action='store_false', help='기존 서버 재사용')
    parser.set_defaults(restart=False)
    return parser


def prepared_runtime(argv):
    """Do not start a seemingly healthy server that cannot propagate satellites.

    Remote shells can select base Anaconda instead of the prepared web venv.
    Delegate the complete command before touching a running server; never mix
    another interpreter's site-packages into this process.
    """
    if importlib.util.find_spec('sgp4') is not None:
        return None
    environment = ROOT / 'project_support/environment/web_venv'
    interpreter = environment / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
    if interpreter.is_file() and Path(sys.prefix).resolve() != environment.resolve():
        print('웹 실행 환경으로 전환합니다: 위성 동기화 의존성 확인', flush=True)
        try:
            return subprocess.call([str(interpreter), '-m',
                                    'user_application.apps.web_dashboard.launcher', *argv], cwd=ROOT)
        except OSError as error:
            print(f'웹 실행 환경을 시작하지 못했습니다: {error}')
            return 1
    print('위성 동기화에 필요한 sgp4가 없습니다. project_support/environment/web_venv 환경을 준비해 주세요.')
    return 1


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    delegated = prepared_runtime(argv)
    if delegated is not None:
        return delegated
    host = args.host or configured_host()
    url = browse_url(host, args.port)
    shared = lan_address(args.port) if host in ANY_HOST else None
    if args.restart:
        try:
            from user_application.apps.web_dashboard.server_restart import restart_existing
            restart_existing(ROOT, args.port, host)
        except (ImportError, OSError, RuntimeError, psutil.Error) as error:
            print(f'안전한 재시작을 완료하지 못했습니다: {error}')
            return 1
    status = server_status(args.port, host)
    if status == 'ready':
        print(f'이미 실행 중인 AeroDT GUI: {url}')
        if not args.no_browser:
            webbrowser.open(url)
        return 0
    if status == 'busy':
        print(f'포트 {args.port}를 다른 프로그램이 사용 중입니다. --port 8767 등으로 실행해 주세요.')
        return 1
    if shared:
        print(f'같은 네트워크의 다른 PC에서: {shared}')
    # Anything but loopback is reachable by other machines, and this server has
    # no login: say so once, every time, so it is never a surprise.
    if host in ANY_HOST:
        print('주의: 모든 인터페이스에 열려 있어 이 PC 밖에서도 접속할 수 있으며 이 서버에는 로그인이 없습니다.')
    elif host not in LOOPBACK:
        print(f'주의: {host}는 이 PC 밖에서도 접속할 수 있는 주소이며 이 서버에는 로그인이 없습니다.')
    # GIL 전환 간격은 기본값(5 ms) 그대로 둔다.
    #
    # 0.0005로 낮추면 이벤트 루프가 시나리오 틱 스레드에게서 GIL을 돌려받는 왕복이
    # 37.8 ms에서 3.4 ms로 줄어, 수동 조종 응답만 보면 분명한 이득이었다. 그런데
    # 이 프로세스의 실제 일은 한 스레드가 아니라 ctypes 네이티브 물리를 도는 스레드
    # 풀에서 벌어진다: 주행 물리 풀 8개, 예측 준비 풀은 코어 수만큼(여기서는 24개).
    # 전환을 열 배 자주 하면 그 풀들이 전부 GIL 호송(convoy)에 걸린다. 실측:
    #
    #     스레드  1 → 1.0배   4 → 5.1배   8 → 10.9배   12 → 19.6배   24 → 43.1배
    #
    # 「기체 예측 준비」가 30초 아래에서 73초로 늘어난 것이 이것이다. 수동 조종 한
    # 경로를 위해 시뮬레이션 전체를 열 배 느리게 만드는 거래여서, 되돌린다.
    # 왕복 자체는 메시지당 스레드 홉을 넷에서 하나로 줄여 따로 줄였다
    # (communication/web/manual_routes.py).
    # A 1 ms scheduler tick for as long as this process serves: every timed
    # wait here (the GIL's switch interval above all) is otherwise rounded up
    # to Windows' 15.6 ms timer, and the pilot's control step waits on a few
    # of them per message. See timer_resolution.py.
    from user_application.apps.web_dashboard.timer_resolution import raise_timer_resolution
    lower_timer_resolution = raise_timer_resolution()
    server = uvicorn.Server(uvicorn.Config(create_app(prepare_config(ROOT,args.port,host)),
        host=host,port=args.port,workers=1))
    stopped = threading.Event()
    def open_when_ready():
        for _ in range(600):
            if stopped.wait(.1):
                return
            if server.started:
                webbrowser.open(url)
                return
    if not args.no_browser:
        threading.Thread(target=open_when_ready,daemon=True).start()
    print(f'AeroDT GUI: {url}  |  종료: Ctrl+C')
    from user_application.apps.web_dashboard.server_restart import watch_shutdown
    close_shutdown = watch_shutdown(server, ROOT)
    try:
        server.run()
    finally:
        if lower_timer_resolution is not None:
            lower_timer_resolution()
        stopped.set()
        close_shutdown()
    return 0 if server.started else 1


if __name__ == '__main__':
    raise SystemExit(main())
