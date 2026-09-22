import math
from types import SimpleNamespace

import pytest

from digital_twin.simulation.scenario_engine import Phase, Route, ScenarioEngine
from user_application.uam_mission.scenario_pilots import ScenarioPilots


def pilot(lead_s=180):
    instance = object.__new__(ScenarioPilots)
    instance.policy = {'arrival_request_lead_s': lead_s}
    return instance


def test_automatic_pilot_owns_the_arrival_request_trigger():
    p = pilot()
    waiting = p.arrival_request_decision(
        remaining_s=181, phase_index=3, descent_index=5, near_entry=False)
    assert waiting['owner'] == 'pilot' and not waiting['due']

    due = p.arrival_request_decision(
        remaining_s=180, phase_index=3, descent_index=5, near_entry=False)
    assert due['due'] and due['lead_s'] == 180

    entered = p.arrival_request_decision(
        remaining_s=500, phase_index=5, descent_index=5, near_entry=False)
    assert entered['due']


def test_near_entry_is_a_pilot_request_fallback_even_if_eta_is_long():
    decision = pilot().arrival_request_decision(
        remaining_s=500, phase_index=3, descent_index=5, near_entry=True)
    assert decision['due'] and decision['reason'] == '도착 진입 구간 도달'


def eta_engine():
    engine=object.__new__(ScenarioEngine)
    engine.policy={'pilot':{'approach_horizontal_speed_mps':10.,'landing_rate_mps':1.2,
                            'descent_rate_mps':2.5,'climb_rate_mps':5.}}
    engine.psu=SimpleNamespace(waiting=SimpleNamespace(reservations={}))
    return engine


def bent_route():
    ground=Phase('gate_out','ground',[(37.,127.,0.),(37.,127.,0.)],0,1)
    cruise=Phase('cruise','cruise',[(37.,127.,100.),(37.,127.01,100.),
                                    (37.01,127.01,100.)],200,10)
    landing=Phase('landing','landing',[(37.01,127.01,100.),
                                       (37.01,127.011,0.)],90,5)
    return Route('bent',[ground,cruise,landing],{},{}),cruise,landing


def test_manual_eta_uses_the_remaining_route_not_a_straight_line_to_touchdown():
    engine=eta_engine();route,cruise,landing=bent_route()
    current=(37.,127.005,100.)
    manual=SimpleNamespace(route=route,index=0,elapsed=0.,latitude=current[0],
        longitude=current[1],altitude=current[2],airborne=True,
        external={'since_s':0},telemetry={},flight={'flight_id':'F1'})
    automatic=SimpleNamespace(route=route,index=1,elapsed=0.,latitude=current[0],
        longitude=current[1],altitude=current[2],airborne=True,
        external={},telemetry={'segment_index':0},flight={'flight_id':'F1'})

    manual_eta=engine._compute_remaining_native(manual)
    automatic_eta=engine._compute_remaining_native(automatic)
    assert manual_eta == pytest.approx(automatic_eta,rel=1e-6)

    touchdown=landing.points[-1]
    straight=math.hypot((touchdown[0]-current[0])*111320,
                        (touchdown[1]-current[1])*111320*math.cos(math.radians(current[0])))
    assert manual_eta > straight/10., '꺾인 항로의 남은 길이를 직선으로 줄이면 안 된다'
