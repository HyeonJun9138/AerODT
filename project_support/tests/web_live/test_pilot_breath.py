"""The server asks Windows for a 1 ms timer while it serves: every timed wait
in the process, the interpreter's switch interval above all, is otherwise
rounded up to the 15.6 ms system timer, and the pilot's control step waits on
a few of them per message."""
import sys

import pytest

from user_application.apps.web_dashboard import timer_resolution


def test_timer_resolution_is_asked_for_on_windows_and_given_back(monkeypatch):
    calls = []
    class Winmm:
        def timeBeginPeriod(self, period): calls.append(('begin', period)); return 0
        def timeEndPeriod(self, period): calls.append(('end', period)); return 0
    monkeypatch.setattr(timer_resolution.ctypes, 'WinDLL', lambda name: Winmm())
    monkeypatch.setattr(timer_resolution.sys, 'platform', 'win32')
    restore = timer_resolution.raise_timer_resolution()
    assert calls == [('begin', 1)] and callable(restore)
    restore()
    assert calls == [('begin', 1), ('end', 1)]
    class Refusing(Winmm):
        def timeBeginPeriod(self, period): return 97
    monkeypatch.setattr(timer_resolution.ctypes, 'WinDLL', lambda name: Refusing())
    assert timer_resolution.raise_timer_resolution() is None
    monkeypatch.setattr(timer_resolution.sys, 'platform', 'linux')
    assert timer_resolution.raise_timer_resolution() is None


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows timer')
def test_on_this_machine_the_request_is_accepted():
    restore = timer_resolution.raise_timer_resolution()
    assert restore is not None
    restore()
