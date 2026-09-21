"""Who is driving the twin right now.

There is one globe, one clock and one fleet on screen, and two things that can
drive them: a whole scheduled day, and a single flight of its own. Running both
at once is not a smaller version of either -- it is two sets of aircraft on one
map with two clocks, which is what an operator saw and reported as everything
going at once.

So the twin is held, by exactly one holder, and the other is refused by name
rather than allowed to start and then fight for the screen. A refusal says what
has it and what to do about it, because "no" without either is a dead end.

The one exception is the aircraft of a running day that a person is flying by
hand: that is the day, not a second thing beside it, so it does not ask.
"""
import threading

DAY = "day"
SINGLE = "single"
LABELS = {DAY: "다중 비행", SINGLE: "단일 비행"}


class TwinBusy(ValueError):
    """Someone else is driving. Carries who, so the message can say so.

    A `ValueError` because that is what every route here already turns into a
    named refusal the page can show; a new exception type would be a new error
    path for the same answer.
    """

    def __init__(self, holder):
        self.holder = holder
        super().__init__(f"{LABELS.get(holder, holder)}이(가) 실행 중입니다. 먼저 종료한 뒤 시작하세요.")


class TwinCustody:
    def __init__(self):
        self._lock = threading.Lock()
        self._holder = None
        self._count = 0

    @property
    def holder(self):
        return self._holder

    def take(self, holder):
        """Take the twin, or raise naming who has it.

        Taking it twice from the same holder is allowed and counted: a day is
        opened once but a manual session inside it comes and goes, and the
        second take must not be refused by the first.
        """
        with self._lock:
            if self._holder not in (None, holder):
                raise TwinBusy(self._holder)
            self._holder = holder
            self._count += 1
            return self._holder

    def release(self, holder):
        """Give it back. Releasing what you do not hold is not an error -- every
        way out calls this, and several of them can run for the same ending."""
        with self._lock:
            if self._holder != holder:
                return False
            self._count = max(0, self._count - 1)
            if not self._count:
                self._holder = None
            return True

    def clear(self, holder=None):
        """Drop it outright, whatever the count. For a teardown that cannot fail."""
        with self._lock:
            if holder is not None and self._holder != holder:
                return False
            self._holder, self._count = None, 0
            return True

    def check(self, holder):
        """Would `take` succeed? For a page that wants to grey a button rather
        than let it be pressed and answered with a refusal."""
        with self._lock:
            return self._holder in (None, holder)

    def state(self):
        with self._lock:
            return {"holder": self._holder, "label": LABELS.get(self._holder), "depth": self._count}
