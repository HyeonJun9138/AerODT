import json
from pathlib import Path
from types import SimpleNamespace
from digital_twin.simulation import decision_policy
from digital_twin.simulation.scenario_engine import ScenarioEngine
from digital_twin.model_library.terminal_paths import conflict
from project_support.tests.web_live.test_scenario_engine import schedule_of, row, VERTIPORTS, NETWORK

ROOT = Path(__file__).resolve().parents[3]

def test_research_profile_relaxes_only_four_scheduling_parameters():
    values = json.loads((ROOT/'user_application/configs/simulation/relaxed_terminal.json').read_text())
    assert values['psu'] == {'terminal_horizontal_m':30, 'terminal_vertical_m':20,
        'entry_spacing_s':60, 'approach_headway_s':15}
    policy = decision_policy.validate(values)
    assert policy['pilot'] == decision_policy.defaults()['pilot']
    assert policy['psu']['terminal_horizontal_m'] == 30
    assert policy['psu']['terminal_vertical_m'] == 20
    assert policy['psu']['fato_landing_separation_s'] == 90
    assert policy['psu']['pad_clear_radius_m'] == 25

def test_terminal_threshold_is_independent_of_observed_traffic():
    policy = {'psu': {'terminal_horizontal_m':30, 'terminal_vertical_m':20}}
    e = ScenarioEngine(schedule_of(row('F','A','VP1','VP2','06:30:00')),
        vertiports=VERTIPORTS,network=NETWORK,policy=policy)
    try:
        assert (e._terminal.horizontal_m,e._terminal.vertical_m) == (30,20)
        assert e.policy['pilot']['traffic_horizontal_m'] == 120
        assert e.policy['pilot']['traffic_vertical_m'] == 45
    finally:e.close()

def test_relaxation_releases_parallel_36m_paths_but_not_crossing_paths():
    def route(points,stage):return SimpleNamespace(phases=[SimpleNamespace(stage=stage,points=points)])
    a=route([(37,127,100),(37.01,127,100)],'descent')
    b=route([(37,127+36/88904,100),(37.01,127+36/88904,100)],'takeoff')
    assert conflict(a,'arrival',b,'departure',120,45)
    assert conflict(a,'arrival',b,'departure',30,20) is None
    crossing=route([(37.005,126.999,100),(37.005,127.001,100)],'takeoff')
    assert conflict(a,'arrival',crossing,'departure',30,20)

def test_saved_relaxation_does_not_change_an_already_loaded_session(tmp_path):
    from data.settings.decision_settings import DecisionSettings
    from project_support.tests.web_live.test_scenario_session import CSV, VERTIPORTS as PORTS, NETWORK as NET
    from user_application.uam_mission.scenario_session import ScenarioSession
    store=DecisionSettings(tmp_path/'decisions.json')
    s=ScenarioSession(vertiports=lambda:PORTS,network=lambda:NET,policy=store.read)
    try:
        s.load(CSV)
        assert s.engine._terminal.horizontal_m==120
        store.write({'psu':{'terminal_horizontal_m':30,'terminal_vertical_m':20,'entry_spacing_s':60,'approach_headway_s':15}})
        assert s.engine._terminal.horizontal_m==120
        s.load(CSV)
        assert s.engine._terminal.horizontal_m==30
        assert s.engine.policy['pilot']['traffic_horizontal_m']==120
    finally:s.close()
