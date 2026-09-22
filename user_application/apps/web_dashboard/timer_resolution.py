"""Ask Windows for a 1 ms scheduler tick while the server runs.

Every timed wait in this process - the interpreter's own switch interval that
a thread waits on for the GIL, asyncio's sleeps, the pools' condition waits -
is rounded up to the system timer, which is 15.6 ms unless somebody asks for
better. Browsers ask while they are in front, which is why the page next to
this server looks smoother than the server behaves. The pilot's control step
pays this several times a message, so the server asks too, for as long as it
serves, and gives it back when it stops.
"""
import ctypes
import sys


def raise_timer_resolution(period_ms=1):
    """Raise the timer resolution; returns the function that lowers it again,
    or None when the platform has no such thing or the request was refused."""
    if sys.platform != 'win32':
        return None
    try:
        winmm = ctypes.WinDLL('winmm')
        if winmm.timeBeginPeriod(int(period_ms)) != 0:
            return None
    except (OSError, AttributeError):
        return None

    def restore():
        try:
            winmm.timeEndPeriod(int(period_ms))
        except (OSError, AttributeError):
            pass
    return restore
