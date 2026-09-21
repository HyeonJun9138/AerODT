"""Prepare flight intent without starting a simulator or granting clearance."""
from digital_twin.model_library import flight_plan


class FlightPlanning:
    def __init__(self, *, vertiports, network, plans, profile=None):
        self._vertiports = vertiports
        self._network = network
        self._plans = plans
        # How fast the aircraft is flown, as the pilot set it. None means the
        # operating figures' own values.
        self._profile = profile

    def options(self):
        return flight_plan.plan_options(self._vertiports(), self._network())

    def build(self, body):
        if not isinstance(body, dict):
            raise ValueError('plan: JSON object expected')
        records, net = self._vertiports(), self._network()
        request = flight_plan.validate_request(body, flight_plan.plan_options(records, net))
        plan = flight_plan.build_plan(request, records, net,
                                      profile=self._profile() if self._profile else None)
        mode=body.get('control_mode','autopilot')
        if mode not in ('autopilot','manual'):raise ValueError('control_mode: invalid mode')
        if mode=='manual':plan['control_mode']=mode
        return plan

    def prepare(self, body):
        # A new revision is a new immutable document, never an in-place edit.
        return self._plans.create(self.build(body))

    def ground_layouts(self):
        return self._vertiports()

    def get(self, plan_id):
        return self._plans.get(plan_id)

