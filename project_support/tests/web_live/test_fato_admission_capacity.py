"""Admission-only comparison; not observed landing throughput or certified capacity."""
from collections import Counter
from types import SimpleNamespace
from digital_twin.simulation.scenario_engine import ScenarioEngine
from digital_twin.model_library.route_network import network as build_network
from project_support.tests.web_live.test_scenario_engine import vertiport, schedule_of, row, NODES, LINKS


def capacity_engine(count, *, flights=1, pilots=None):
    ports=[vertiport('VP1','출발',37.525,126.920,fatos=[{'role':'both'}]*count),
           vertiport('VP2','도착',37.478,126.941,fatos=[{'role':'both'}]*count)]
    links=[dict(LINKS[1])]
    for i in range(1,count+1):
        links.extend([dict(LINKS[0],id=f'D{i}',**{'from':f'fato:VP1:F{i}'}),
                      dict(LINKS[2],id=f'A{i}',to=f'fato:VP2:F{i}')])
    rows=[row(f'F{i}',f'A{i}','VP1','VP2','06:31:00',stand=f'G{i}',arrival_stand=f'G{i}').replace(',F2,',',F1,')
          for i in range(1,flights+1)]
    schedule=schedule_of(*rows,vertiports=ports)
    return ScenarioEngine(schedule,vertiports=ports,network=build_network(NODES,links,ports),pilots=pilots)


def compare_admission(count, demand=12):
    engine=capacity_engine(count)
    # Equal cached lead times isolate the queue/allocation behaviour, not physics.
    engine.pilots=SimpleNamespace(cached_entry_estimate=lambda *args:500,estimate_to_entry=lambda *args:500)
    now=23460;waits=[];usage=Counter();entries={}
    try:
        aircraft=engine.aircraft['A1']
        for i in range(demand):
            flight=dict(engine.flights['F1'],flight_id=f'Q{i}')
            selected,route=engine._select_fatos(flight,now)
            engine._meter_arrival_entry(aircraft,selected,route,now)
            slot=engine._entry_forecasts[flight['flight_id']]
            waits.append(slot['departure_s']-now)
            usage[selected['arrival_fato']]+=1
            entries.setdefault(selected['arrival_fato'],[]).append(slot['entry_s'])
        spacing=max(engine.policy['psu']['entry_spacing_s'],2*engine.policy['psu']['approach_headway_s'])
        for times in entries.values():
            assert all(b-a>=spacing-1e-6 for a,b in zip(sorted(times),sorted(times)[1:]))
        return {'fato_count':count,'requests':demand,'mean_admission_wait_s':sum(waits)/demand,
                'maximum_admission_wait_s':max(waits),'admitted_without_entry_delay':sum(w==0 for w in waits),
                'assigned_requests_per_pad':dict(usage),'same_pad_spacing_s':spacing}
    finally:
        engine.pilots=None
        engine.close()


def test_one_and_four_fatos_use_different_admission_queues_without_relaxing_spacing():
    single,multi=compare_admission(1),compare_admission(4)
    assert single['same_pad_spacing_s']==multi['same_pad_spacing_s']
    assert single['admitted_without_entry_delay']==1
    assert multi['admitted_without_entry_delay']==4
    assert len(multi['assigned_requests_per_pad'])==4
    assert multi['mean_admission_wait_s']<single['mean_admission_wait_s']
    print({'single':single,'multi':multi})
