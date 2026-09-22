import pytest
from digital_twin.model_library import flight_scheduler
from user_application.uam_mission import plan_generation
from project_support.tests.web_live.test_flight_scheduler import fleet, stands, timing
from project_support.tests.web_live.test_plan_generation import request, vertiports, network


def build(preference=None):
    return flight_scheduler.schedule(
        demand=[{'hour': 6, 'from': 'VP1', 'to': 'VP2', 'passengers': 80}],
        fleet=fleet(('VP1', 'G1', 4), ('VP1', 'G2', 6), ('VP1', 'G3', 8), ('VP1', 'G4', 6)),
        stands={'VP1': stands(5), 'VP2': stands(5)}, timing=timing,
        start_minutes=390, end_minutes=450, seed=1,
        planning={'fato_headway_s': 60}, manual_preference=preference)['flights']


def test_selected_seat_first_flight_gets_first_slot_not_permanent_priority():
    ordinary = build()
    result = build({'seats': 6, 'vertiport': 'VP1'})
    assert ordinary[0]['aircraft_id'] == 'UAM0001'
    assert result[0]['aircraft_id'] == 'UAM0002'
    assert result[0]['off_block_s'] == 390 * 60
    assert [r['aircraft_id'] for r in result[:4]] == ['UAM0002', 'UAM0001', 'UAM0003', 'UAM0004']
    assert all(b['lift_off_s'] - a['lift_off_s'] >= 60 for a,b in zip(result,result[1:]))
    assert result == build({'seats': 6, 'vertiport': 'VP1'})


def test_unavailable_preference_keeps_ordinary_plan_and_does_not_invent_aircraft():
    assert build({'seats': 6, 'vertiport': 'VP2'}) == build()
    assert build({'seats': 2}) == build()


def test_generator_validates_manual_filters_and_leaves_disabled_request_ordinary():
    result = plan_generation.validate_request(request(manual={'want': True, 'seats': '6', 'vertiport': 'VP1'}))
    assert result['manual_preference'] == {'seats': 6, 'vertiport': 'VP1'}
    assert plan_generation.validate_request(request())['manual_preference'] is None
    for manual in [{'want': True, 'seats': '9'}, {'want': True, 'vertiport': 'missing'}]:
        with pytest.raises(plan_generation.GenerationError):
            plan_generation.validate_request(request(manual=manual))


def test_generator_passes_preference_through_demand_routes_and_dispatch():
    asked = plan_generation.validate_request(request(manual={'want': True, 'seats': '6', 'vertiport': 'VP1'}))
    result = plan_generation.generate(asked, vertiports=vertiports, network=network)
    first = result['answer']['flights'][0]
    assert first['seat_capacity'] == 6
    assert first['origin_vertiport_id'] == 'VP1'
    assert first['off_block_s'] == 7 * 3600
