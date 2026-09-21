"""Observe the existing fleet pilots at sensor cadence, without changing guidance."""
from user_application.uam_mission.scenario_pilots import ScenarioPilots


class SensorScenarioPilots(ScenarioPilots):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);self.observations={};self.capture=True

    def advance(self,aircraft_id,seconds,hold=None):
        pilot=self.flights[aircraft_id]
        if not self.capture:return super().advance(aircraft_id,seconds,hold)
        samples=[];elapsed=0.;remaining=max(0.,seconds)
        while remaining>1e-8:
            step=min(.02,remaining);state=super().advance(aircraft_id,step,hold)
            elapsed+=step;remaining-=step
            samples.append((elapsed,state))
            if state['done']:break
        if not samples:
            state=super().advance(aircraft_id,0,hold);samples.append((0.,state))
        self.observations[aircraft_id]=(samples,pilot.prediction_points,hold)
        return state

    def drain(self):
        result=self.observations;self.observations={};return result
