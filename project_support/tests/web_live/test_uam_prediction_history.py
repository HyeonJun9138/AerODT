import math
import pytest
from data.simulation.prediction_history import PredictionHistory

def row(t,yaw=0):
    return tuple([t,t,0,100,0,0,yaw]+[0]*14)

def test_interpolates_only_observed_history_and_preserves_seconds_and_angle_wrap():
    h=PredictionHistory()
    for i in range(61):h.append('a','mission',i*.5,row(23000+i*.5,179 if i==0 else -179))
    result=h.window('a','mission',30,.4)
    assert result['status']=='ready' and len(result['rows'])==25
    assert result['rows'][0][0]==pytest.approx(23020.4)
    assert result['rows'][-1][0]==23030
    assert h.window('a','mission',30,1.2)['rows'][0][0]==pytest.approx(23001.2)
    assert h.window('a','mission',31,.4)['status']=='warming_up'
    angles=PredictionHistory();angles.append('a','m',0,row(0,179));angles.append('a','m',1,row(1,-179))
    assert abs(angles.window('a','m',1,.5,steps=3)['rows'][1][6])==180
    assert angles.window('a','m',1,.5,steps=3)['rows'][-1][6]==-179

def test_missing_history_large_gaps_mission_change_and_backward_time_reset():
    h=PredictionHistory()
    h.append('a','m',0,row(0));assert h.window('a','m',0,.4)['status']=='warming_up'
    h.append('a','m',30,row(30));assert h.window('a','m',30,.4)['status']=='warming_up'
    h.append('a','new',31,row(31));assert h.window('a','new',31,.4)['available_history_seconds']==0
    h.append('a','new',5,row(5));assert h.window('a','new',5,.4)['available_history_seconds']==0
    assert h.window('a','other',5,.4)['status']=='warming_up'

def test_duplicates_immutable_values_and_memory_are_bounded():
    h=PredictionHistory(max_entities=2,max_samples=40)
    values=list(row(0));h.append('a','m',0,values);values[1]=9
    for n in range(100):h.append('a','m',n,row(n))
    h.append('b','m',0,row(0));h.append('c','m',0,row(0))
    assert len(h.entries)==2 and 'a' not in h.entries
    assert h.append('b','m',1,[math.nan]*21) is False
    assert len(h.entries['b'][1])==1


def test_target_change_does_not_create_an_uncommanded_intermediate_waypoint():
    h=PredictionHistory()
    a=list(row(0));b=list(row(1))
    a[16:]=[20,1,100,0,0];b[16:]=[40,2,0,100,10]
    h.append('a','m',0,a,target_key='old')
    h.append('a','m',1,b,target_key='new')
    rows=h.window('a','m',1,.25,steps=5)['rows']
    assert rows[1][16:]==tuple(a[16:])
    assert rows[2][16:]==tuple(b[16:])
    assert rows[1][0]==.25,'continuous kinematics are still interpolated'


def test_frequent_read_requests_do_not_evict_the_required_history():
    h=PredictionHistory()
    for n in range(4001):h.append('a','m',n*.01,row(n*.01))
    assert len(h.entries['a'][1])<=240
    assert h.window('a','m',40,1.2)['status']=='ready'
