"""Application queries: one evaluated copy, shared by summary and drill-down."""
import csv
import io
import threading
import time

from user_application.uam_mission.operations_analysis import build_report, select_sorties


class OperationsReports:
    def __init__(self, session, records, clock=time.monotonic):
        self.session, self.records, self.clock = session, records, clock
        self._lock = threading.Lock()
        self._cached = None
        self._key = None
        self._at = 0

    def records_list(self):
        return {'schema_version': 1, 'records': self.records.list()}

    def report(self, recording='current'):
        with self._lock:
            stamp = (getattr(self.session, 'analysis_cache_key', self.session.analysis_stamp)()
                     if recording == 'current' else recording)
            key = (recording, stamp)
            now = self.clock()
            if self._cached is not None and key == self._key and now-self._at < 5:
                return self._cached
            source = self.session.analysis_input() if recording == 'current' else self.records.read(recording)
            report = build_report(source) if source else None
            self._key, self._at, self._cached = key, self.clock(), report
            return report

    def summary(self, recording='current'):
        report = self.report(recording)
        return {'schema_version': 1, 'available': False} if report is None else {
            **{k: v for k, v in report.items() if k != 'sorties'}, 'available': True}

    def sorties(self, recording='current', **filters):
        report = self.report(recording)
        return None if report is None else select_sorties(report, **filters)

    def sortie(self, flight_id, recording='current'):
        report = self.report(recording)
        if report is None:
            return None
        row = next((r for r in report['sorties'] if r['flight_id'] == flight_id), None)
        return {'schema_version': 1, 'meta': report['meta'], 'row': row} if row else None

    def export(self, recording='current'):
        report = self.report(recording)
        if report is None:
            return None
        stream = io.StringIO(newline='')
        fields = ('flight_id', 'aircraft_id', 'origin', 'destination', 'status', 'passengers',
                  'planned_departure_s', 'actual_departure_s', 'departure_delta_s',
                  'planned_arrival_s', 'actual_arrival_s', 'arrival_delta_s', 'hold_s',
                  'planned_departure_fato', 'departure_fato', 'planned_arrival_fato', 'arrival_fato',
                  'energy_used_kwh', 'energy_deficit_kwh', 'charge_grid_kwh', 'battery_min_pct')
        writer = csv.writer(stream)
        writer.writerow(fields)
        for row in report['sorties']:
            writer.writerow([("'"+value if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@')) else value)
                             for value in (row.get(field) for field in fields)])
        return '\ufeff' + stream.getvalue()
