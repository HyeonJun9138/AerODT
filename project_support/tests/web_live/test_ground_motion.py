import math
import pytest
from digital_twin.model_library.ground_motion import prepare,at,ACCEL_MPS2
from digital_twin.simulation import flight_simulation as sim,native_flight_engine as native
from digital_twin.model_library.ground_motion import heading_at,align_start,turn_delta,YAW_RATE_DPS


@pytest.mark.parametrize('sign',[-1,1])
def test_heading_and_position_turn_together_with_bounded_yaw_rate(sign):
    path,p,d,duration=prepare([(37,127),(37.0003,127),(37.0003,127+sign*.0004)],4,8)
    leg={'path':[[lon,lat,0,'deck:test'] for lat,lon in path]}
    last=None
    for step in range(int(duration*50)+1):
        t=step/50;fraction,speed=at(p,t);heading=heading_at(p,fraction,t)
        if last is not None:assert abs(turn_delta(last,heading))/.02<=YAW_RATE_DPS+.001
        if speed>.1:
            chord=sim.along_leg(leg,fraction)['heading_deg']
            assert abs(turn_delta(chord,heading))<3,'No corner-scale sideslip from delayed yaw'
        last=heading


def test_initial_alignment_is_completed_while_stopped_and_keeps_end_hold():
    path,p,d,duration=prepare([(37,127),(37.0003,127)],4,8)
    leg={'ground_motion':p,'duration_s':duration}
    align_start(leg,180)
    assert p['times_s'][0]>=28
    assert at(p,27)==(0,0)
    assert heading_at(p,0,0)==180
    assert heading_at(p,0,27)==pytest.approx(0)
    assert leg['duration_s']-p['times_s'][-1]>=4
    last=180
    for i in range(1,2801):
        h=heading_at(p,0,i/100)
        assert abs(turn_delta(last,h))/.01<=YAW_RATE_DPS+.001
        last=h


def test_ground_motor_lifecycle_does_not_delay_motion_heading():
    states=[{'leg':0,'stage':'gate_in','t':t,'heading_deg':h} for t,h in [(1,0),(2,80),(3,90)]]
    native._ground_motor_lifecycle(states,{'legs':[{'end_s':40}]},{'heading_deg':180,'t':0,'rotor_radps':200})
    assert [s['heading_deg'] for s in states]==[0,80,90]

def test_corner_speed_profile_brakes_and_recovers_without_moving_endpoints():
    points=[(37,127),(37.0003,127),(37.0003,127.0004)]
    path,p,d,duration=prepare(points,4,8)
    assert path[0]==points[0] and path[-1]==points[-1]
    assert duration>d/4+8
    assert min(p['speeds_mps'][5:-5])<2
    assert max(p['speeds_mps'])==pytest.approx(4)
    assert at(p,0)==(0,0) and at(p,duration)==(1,0)
    for i in range(1,len(p['times_s'])):
        dt=p['times_s'][i]-p['times_s'][i-1]
        ds=p['distances_m'][i]-p['distances_m'][i-1]
        assert ds==pytest.approx((p['speeds_mps'][i]+p['speeds_mps'][i-1])*dt/2)
        assert abs(p['speeds_mps'][i]-p['speeds_mps'][i-1])/dt<=ACCEL_MPS2+1e-7
    for lat,lon in path:assert 37<=lat<=37.0003 and 127<=lon<=127.0004

def test_short_leg_and_stationary_leg_are_finite():
    for distance in [.002,.1,1,10]:
        _,p,d,duration=prepare([(37,127),(37+distance/111195,127)],4,8)
        assert math.isfinite(duration) and duration>8
        assert at(p,duration)==(1,0)
    assert prepare([(37,127),(37,127)],4,8)[1] is None

def test_state_reports_distance_fraction_but_energy_uses_elapsed_time():
    path,p,d,duration=prepare([(37,127),(37.0003,127),(37.0003,127.0004)],4,8)
    leg={'path':[[lon,lat,0,'deck:test'] for lat,lon in path], 'ground_motion':p,'start_s':0,'end_s':duration,
         'duration_s':duration,'battery_start_pct':100,'battery_end_pct':90,'kind':'ground','stage':'gate_out',
         'distance_m':d,'speed_mps':4}
    plan={'legs':[leg],'totals':{'duration_s':duration}}
    a=sim.state_at(plan,2)
    assert a['f']==0 and a['speed_mps']==0
    assert a['battery_pct']<100
    for t in range(5,int(duration)-5):
        a=sim.state_at(plan,t);b=sim.state_at(plan,t+.01)
        measured=(b['f']-a['f'])*d/.01
        assert abs(measured-a['speed_mps'])<.04

def test_runner_input_declares_initial_ground_heading():
    assert 'initial_yaw 55\n' in native.render_input([],initial_yaw_deg=55)
    with pytest.raises(ValueError):native.render_input([],initial_yaw_deg=float('nan'))

@pytest.mark.skipif(native.runner_path('.') is None,reason='native runner not built')
def test_real_runner_starts_and_lifts_with_requested_heading():
    import subprocess
    points=[dict(north_m=0,east_m=0,down_m=-20,speed_mps=3,fixed_wing=False,capture_m=1.5)]
    result=subprocess.run([str(native.runner_path('.'))],input=native.render_input(points,initial_yaw_deg=55),text=True,capture_output=True,timeout=60)
    states,ending,error=native.parse_output(result.stdout)
    assert result.returncode==0 and not error and ending['reached']==1
    assert states[0]['yaw_deg']==pytest.approx(55,abs=.01)
    assert max(abs(s['yaw_deg']-55) for s in states)<1
    assert max(abs(s['pitch_deg']) for s in states)<1


def test_pushback_reverses_turns_then_changes_to_forward_without_stationary_spin():
    from digital_twin.model_library.ground_motion import prepare_pushback
    points=[(37,127),(37+45/111195,127),(37+45/111195,127.0004)]
    result=prepare_pushback(points,180,4,8)
    assert result is not None
    path,p,d,duration=result
    assert path[0]==points[0] and path[-1]==points[-1]
    assert abs(turn_delta(heading_at(p,0,0),180))<2
    cusp=p['pushback_end_m'];i=p['distances_m'].index(cusp)
    assert p['speeds_mps'][i]==0
    assert abs(turn_delta(p['headings_deg'][i-1],p['headings_deg'][i+1]))<10
    assert 'heading_alignment' not in p
    assert max(p['speeds_mps'][:i+1])<=1.5
    assert prepare_pushback(points,0,4,8) is None


@pytest.mark.parametrize('side',[-1,1])
def test_pushback_advance_passes_zero_speed_cusp_and_finishes(side):
    from digital_twin.model_library.ground_motion import prepare_pushback,advance
    _,p,total,_=prepare_pushback([(37,127),(37+45/111195,127),(37+45/111195,127.0004)],180,4,8,side=side)
    distance=speed=0
    for _ in range(3000):
        distance,speed=advance(p,distance,speed,total,4,.05)
        if distance>=total-1e-6:break
    assert distance==pytest.approx(total)
    assert speed==pytest.approx(0)
