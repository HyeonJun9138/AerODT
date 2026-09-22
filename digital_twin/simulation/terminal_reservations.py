"""Observed terminal movements reserve intersecting route volumes.

This is deliberately conservative, independent of ETA. Following arrivals on
the same FATO remain under PSU headway/final occupancy checks. Other intersecting
movements wait until the owner is observed outside its terminal movement.
"""
from digital_twin.model_library.terminal_paths import conflict


class TerminalReservations:
    def __init__(self, horizontal_m, vertical_m, enabled=True, *, assume_mixed_separated=False, assume_distinct_fatos_separated=False):
        self.horizontal_m, self.vertical_m = horizontal_m, vertical_m
        self.enabled = bool(enabled)
        self.assume_mixed_separated = bool(assume_mixed_separated)
        self.assume_distinct_fatos_separated = bool(assume_distinct_fatos_separated)
        self.claims, self._geometry = {}, {}
        # Answers of `blockers`, kept only while the claims they were read
        # from stand: `acquire` and `release` are the only writers of
        # `claims`, and both empty this.
        self._blockers = {}

    def blockers(self, flight, route, kind):
        # Switched off, the movements are still claimed and released - the
        # geometry stays available to whatever else reads it - but nothing is
        # held for crossing a volume somebody else has spoken for. Pads,
        # headway and stand egress go on deciding; only this one reason stops.
        if not self.enabled:
            return []
        place = flight['origin'] if kind == 'departure' else flight['destination']
        fato = flight[kind + '_fato']
        key = (flight['flight_id'], place, fato, route.key, kind,
               self.assume_mixed_separated, self.assume_distinct_fatos_separated)
        remembered = self._blockers.get(key)
        if remembered is not None:
            return [dict(item) for item in remembered]
        result = self._blockers_now(flight, route, kind, place, fato)
        if len(self._blockers) >= 4096:
            self._blockers.clear()
        self._blockers[key] = result
        return [dict(item) for item in result]

    def _blockers_now(self, flight, route, kind, place, fato):
        result = []
        for (owner, other_kind), other in self.claims.items():
            if owner == flight['flight_id']:
                continue
            if kind == other_kind == 'arrival' and (place, fato) == (other['vertiport'], other['fato']):
                continue
            # Same-port distinct pads may share a nominal WP in the research
            # layout. Dynamic traffic and real pad occupancy still arbitrate.
            if self.assume_distinct_fatos_separated and place == other['vertiport'] and fato != other['fato']:
                continue
            overlap = self.overlap(route, kind, other['route'], other_kind)
            if overlap:
                result.append(dict(overlap, flight_id=owner, operation=other_kind,
                                   vertiport=other['vertiport'], fato=other['fato']))
        return sorted(result, key=lambda r: (r['flight_id'], r['operation']))

    def overlap(self, route, kind, other, other_kind):
        # Research assumption only: flight-side right-hand separation is
        # assumed, not computed here. Keep pad/ground and same-direction checks.
        if self.assume_mixed_separated and {kind, other_kind} == {'arrival', 'departure'}:
            return None
        key = (route.key, kind, other.key, other_kind)
        if key not in self._geometry:
            if len(self._geometry) >= 8192:
                self._geometry.clear()
            self._geometry[key] = conflict(route, kind, other, other_kind,
                                           self.horizontal_m, self.vertical_m)
        return self._geometry[key]

    def acquire(self, flight, route, kind):
        blockers = self.blockers(flight, route, kind)
        if blockers:
            return blockers
        self.claims[(flight['flight_id'], kind)] = {
            'route': route, 'vertiport': flight['origin' if kind == 'departure' else 'destination'],
            'fato': flight[kind + '_fato']}
        self._blockers.clear()
        return []

    def release(self, flight_id, kind):
        released = self.claims.pop((flight_id, kind), None) is not None
        if released:
            self._blockers.clear()
        return released
