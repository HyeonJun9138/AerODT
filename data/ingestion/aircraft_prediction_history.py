"""Bounded past provider reports, never a copy of the current World state."""
class AircraftPredictionHistory:
    def __init__(self):
        self._reports = {}

    def clear(self):
        self._reports.clear()

    def keep(self, identifiers):
        self._reports = {key: value for key, value in self._reports.items() if key in identifiers}

    def observe(self, identifier, moment, position, velocity, reset=False):
        previous = () if reset else self._reports.get(identifier, ())
        if previous and moment <= previous[-1][0]:
            return
        if previous and moment-previous[-1][0] > 45:
            previous = ()
        self._reports[identifier] = (*previous, (moment, tuple(position), tuple(velocity)))[-32:]

    def read(self, identifier):
        return self._reports.get(identifier, ())
