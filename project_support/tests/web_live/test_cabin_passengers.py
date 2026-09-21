import pytest
from digital_twin.model_library.passenger_boarding import onboard,door_spec
from project_support.tests.web_live.test_flight_plan import plan

def test_count_follows_sill_crossing_not_whole_walk_percentage():
    b={'release_s':[2,4,6], 'walk_s':10, 'enter_s':1}
    assert onboard(b,12)==0
    assert onboard(b,13)==1
    assert onboard(b,17)==3
    assert onboard(b,4,True)==1
    assert onboard(b,0,True)==3

@pytest.mark.parametrize('asset',['projectairsim_airtaxi','kp2a','joby_s4','amvlab_evtol'])
def test_model_door_height_side_and_taxi_wait(asset):
    p=plan(visual_asset_id=asset,passengers=2)
    for phase in ('boarding','alighting'):
        b=p[phase];i=0 if phase=='alighting' else -1
        assert b['path_height_offsets_m'][i]==door_spec(asset)['height_m']
        assert b['door_side'] in (-1,1)
        assert len(b['path_height_offsets_m'])==len(b['path'])
        assert b['release_s'][0]>=2
        assert all(z>=a for a,z in zip(b['distances_m'],b['distances_m'][1:]))
    assert p['legs'][0]['ground_motion']['times_s'][0]>=p['boarding']['duration_s']
