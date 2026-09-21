"""AeroDT GUI entry point: python main.py (Ctrl+C to stop)."""
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parent
    python = root / 'project_support/environment/web_venv/Scripts/python.exe'
    if not python.is_file():
        python = root / 'project_support/environment/web_venv/bin/python'
    if not python.is_file():
        print('GUI Python environment is missing. See user_application/apps/web_dashboard/README.md.')
        return 1
    try:
        arguments = sys.argv[1:]
        if '--restart' not in arguments and '--reuse' not in arguments:
            arguments = ['--restart', *arguments]
        return subprocess.call([str(python), '-m', 'user_application.apps.web_dashboard.launcher', *arguments], cwd=root)
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
