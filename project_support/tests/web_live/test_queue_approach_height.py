"""The authored landing entry must not be rejected by air-to-air separation."""
from types import SimpleNamespace
import pytest
from digital_twin.simulation.scenario_engine import ScenarioEngine
from digital_twin.simulation.holding_queue import HoldingQueue


def fixture(ground=0., target_height=40.):
    target=(37.5392392,127.0422975,target_height)
    a=SimpleNamespace(latitude=37.5391046,longitude=127.0423883,altitude=58.36,
        flight={'flight_id':'lead'},route=SimpleNamespace(landing_index=0,
        phases=[SimpleNamespace(points=[target,(target[0],target[1],10.)])]))
    q=HoldingQueue();q.reservations['lead']={'owner':'lead','rejoin':target,'target':(37.54038,127.04374,60.),'state':'returning'}
    e=SimpleNamespace(policy={'pilot':{'traffic_horizontal_m':120.,'traffic_vertical_m':45.,'traffic_lookahead_s':35.}},
        psu=SimpleNamespace(waiting=q),_elevation=None,
        _ground_height=lambda lat,lon,fallback:ground,
        _queue_observations=lambda:[])
    return e,a,target


def test_authorized_40m_entry_is_reachable_from_58m_with_45m_traffic_separation():
    e,a,target=fixture()
    assert ScenarioEngine._queue_transfer_clear(e,a,target)


def test_entry_30m_above_local_terrain_is_reachable():
    e,a,target=fixture(ground=10.)
    assert ScenarioEngine._queue_transfer_clear(e,a,target)


def test_arbitrary_low_detour_does_not_receive_landing_entry_exception():
    e,a,target=fixture()
    assert not ScenarioEngine._queue_transfer_clear(e,a,(target[0]+.001,target[1],40.))


def test_near_ground_landing_entry_is_not_a_touchdown_authorization():
    e,a,target=fixture(ground=38.)
    assert not ScenarioEngine._queue_transfer_clear(e,a,target)


def test_terrain_ridge_still_blocks_entry():
    e,a,target=fixture()
    e._ground_height=lambda lat,lon,fallback: 45. if abs(lat-(a.latitude+target[0])/2)<.00001 else 0.
    assert not ScenarioEngine._queue_transfer_clear(e,a,target)


def test_observed_aircraft_still_blocks_entry():
    e,a,target=fixture()
    e._queue_observations=lambda:[{'owner':'other','position':target,'velocity':(0.,0.,0.)}]
    assert not ScenarioEngine._queue_transfer_clear(e,a,target)


def test_unknown_terrain_does_not_receive_exception():
    e,a,target=fixture();e._elevation=object();e._ground_height=lambda lat,lon,fallback:fallback
    assert not ScenarioEngine._queue_transfer_clear(e,a,target)
