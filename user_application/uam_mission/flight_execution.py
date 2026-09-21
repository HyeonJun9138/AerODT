"""Batch flight application: consume prepared intent, execute, keep evidence.

This is NOT a traffic clearance authority. The current batch scenario assumes
clearances are prearranged. A player pause is not a pilot hold command.
"""
import copy
import threading
import uuid

from digital_twin.simulation import flight_simulation, native_flight_engine


class FlightExecution:
    def __init__(self, *, planning, runs, root, engine='auto', native=None, kinematic=None):
        self.planning, self.runs, self.root = planning, runs, root
        self.engine = engine if engine in ('auto', 'native', 'kinematic') else 'auto'
        self._native = native or native_flight_engine.run
        self._kinematic = kinematic or flight_simulation.run
        # Current dashboard is a single-flight batch tool. Keep expensive native
        # jobs bounded while HTTP reads and the live twin remain responsive.
        self._calculation = threading.BoundedSemaphore(1)

    def list(self):
        return self.runs.list()

    def get(self, run_id):
        return self.runs.get(run_id)

    def plan(self, run_id):
        return self.runs.plan(run_id)

    def states(self, run_id, since=None, until=None):
        return self.runs.states(run_id, since=since, until=until)

    def delete(self, run_id):
        return self.runs.delete(run_id)

    def fly(self, body):
        if not self._calculation.acquire(blocking=False):
            raise BlockingIOError('another batch flight is being calculated')
        try:
            return self._fly(body)
        finally:
            self._calculation.release()

    def _fly(self, body):
        if not isinstance(body, dict):
            raise ValueError('run: JSON object expected')
        # Fail closed instead of silently pretending a mid-flight command ran.
        if 'commands' in body or body.get('execution_mode', 'batch_precleared') != 'batch_precleared':
            raise ValueError('execution_mode: only batch_precleared execution is available; live commands are not supported')
        if 'plan_id' in body:
            if set(body) - {'plan_id', 'rate_hz', 'execution_mode'}:
                raise ValueError('plan_id: prepared plans cannot be overridden; prepare a new plan')
            prepared = self.planning.get(body['plan_id'])
            if prepared is None:
                raise ValueError('plan_id: prepared plan is missing or damaged')
        else:
            # Legacy clients still work, but even they now leave prepared intent.
            prepared = self.planning.prepare(body)
        plan = copy.deepcopy(prepared['plan'])
        execution_id = uuid.uuid4().hex
        execution = {
            'schema_version': 1, 'execution_id': execution_id,
            'plan_id': prepared['plan_id'], 'plan_sha256': prepared['content_sha256'],
            'mode': 'batch_precleared', 'live_commands_supported': False,
            'vehicle_instance_id': 'vehicle-' + execution_id,
            'pilot_id': 'pilot-' + execution_id,
        }
        rate = body.get('rate_hz', flight_simulation.DEFAULT_RATE_HZ)
        flown, refused = None, None
        if self.engine != 'kinematic':
            try:
                flown = self._native(plan, rate, root=self.root)
            except ValueError as problem:
                if self.engine == 'native':
                    raise
                # Existing auto fallback policy is preserved and disclosed.
                refused = str(problem)
        if flown is None:
            flown = self._kinematic(plan, rate)
            if refused:
                flown['summary']['engine_note'] = refused
        # Re-timing belongs to the result, never to the original planned intent.
        plan = flown.get('plan') or plan
        plan['execution'] = execution
        summary = dict(flown['summary'], execution=execution)
        manifest = self.runs.create(plan, flown['states'], summary)
        return {'run': manifest, 'plan': plan, 'states': flown['states']}
