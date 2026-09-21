"""Re-run one saved request without changing its original recorded states."""
import argparse
import json
from pathlib import Path
from digital_twin.model_library import flight_plan, vertiport_layout, route_network
from digital_twin.model_library.visual_catalog import read_visual_catalog
from digital_twin.simulation import native_flight_engine as native, flight_simulation as sim


def metrics(plan, states):
    errors, rates, prior = [], [], None
    for state in states:
        if state['stage'] != 'gate_in': continue
        if state['speed_mps'] > .2:
            target = sim.along_leg(plan['legs'][state['leg']], state['f'])['heading_deg']
            errors.append(abs((target-state['heading_deg']+180)%360-180))
        if prior:
            rates.append(abs((state['heading_deg']-prior['heading_deg']+180)%360-180)/(state['t']-prior['t']))
        prior = state
    return {'max_heading_chord_error_deg': max(errors), 'max_yaw_rate_dps': max(rates),
            'taxi_duration_s': next(l['duration_s'] for l in plan['legs'] if l['stage']=='gate_in')}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('run_id');args=parser.parse_args()
    if Path(args.run_id).name!=args.run_id:parser.error('run_id must be a single directory name')
    root=Path(__file__).resolve().parents[3];workspace=root/'data/workspace/simulation'
    old=workspace/'runs'/args.run_id
    before=json.loads((old/'plan.json').read_text(encoding='utf-8'))
    records=[]
    for p in json.loads((workspace/'vertiports.json').read_text(encoding='utf-8'))['vertiports']:
        d=vertiport_layout.validate_definition(p);records.append(dict(d,layout=vertiport_layout.generate_layout(d)))
    routes=json.loads((workspace/'routes.json').read_text(encoding='utf-8'))
    plan=flight_plan.build_plan(before['request'],records,route_network.network(routes['nodes'],routes['links'],records))
    after=native.run(plan,root=root)
    oldstates=[json.loads(s) for s in (old/'states.jsonl').read_text().splitlines()]
    result={'source_run':args.run_id,'before':metrics(before,oldstates),'after':metrics(after['plan'],after['states'])}
    after['arrival_record']=next(r for r in records if r['id']==plan['arrival']['vertiport'])
    after['assets']=[a for a in read_visual_catalog(root/'digital_twin/model_library/visual_assets')['assets'] if a['asset_id']=='projectairsim_airtaxi']
    out=root/'data/workspace/visualization_checks/taxi_heading';out.mkdir(parents=True,exist_ok=True)
    (out/'run.json').write_text(json.dumps(after),encoding='utf-8')
    (out/'metrics.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))


if __name__=='__main__':main()
