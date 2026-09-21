"""Ground observations constrain the existing posterior, never simulator truth.

An explicit stop captures a candidate pose immediately and confirms it using
advancing observations. Retained measurements keep their original sample age.
"""
import math
from dataclasses import replace
from foundation.geodesy import from_ecef,to_ecef
from digital_twin.model_library.uam_alignment import MODEL
from digital_twin.live_twin.domains.uam.sensor_covariance import expand,project


def constrain(state,old,record,target,enabled):
    cfg=MODEL['ground_constraints']
    p=record['packet'];s=record.get('aligned_sensors',p['sensors']);offset=record.get('clock_offset_s',0.)
    g=s.get('gnss');vehicle=s.get('vehicle');imu=s.get('imu');ahrs=s.get('ahrs')
    def recent(item,limit):return bool(item and -.05<=target-item['sample_time']-offset<=limit)
    def fresh(item):return recent(item,cfg['max_sample_age_s'])
    def release(current):
        return replace(current,stationary_since=None,stationary_position=None,stationary_attitude=None,
                       stationary_motion_count=0,stationary_motion_time=-1.)
    phase=vehicle.get('values',{}).get('flight_phase') if vehicle else None
    contact=bool(enabled and vehicle and vehicle['values'].get('grounded') is True and
                 phase in ('parked','charge','gate_in','gate_out'))
    surface=False;ref=p.get('surface_reference')
    if contact and ref and recent(vehicle,cfg['hold_grace_s']) and recent(g,cfg['hold_grace_s']):
        fixed=tuple(a+b for a,b in zip(state.anchor,expand(state.position,state.axes)))
        lat,lon,height=from_ecef(fixed)
        if abs(height-ref['altitude_m'])<=cfg['surface_gate_m']:
            fixed=to_ecef(lat,lon,ref['altitude_m'])
            state=replace(state,position=project(tuple(a-b for a,b in zip(fixed,state.anchor)),state.axes),
                          velocity=(*state.velocity[:2],0.))
            surface=True
    declared_stop=phase in ('parked','charge') or (p.get('operations') or {}).get('ground_waiting') is True
    held=bool(old and old.stationary_position is not None and state.time-old.time<=MODEL['expiry_seconds'])
    # Losing freshness is not evidence of movement. Once captured, preserve the
    # last stop reference through an outage until the entity's normal expiry.
    # Cold acquisition still needs the shorter lease; neither extends sample
    # timestamps or reports a fresh stationary solution during the outage.
    lease=MODEL['expiry_seconds'] if held else cfg['hold_grace_s']
    recent_stop=bool(contact and declared_stop and all(recent(item,lease) for item in (g,vehicle,imu,ahrs)))
    if not recent_stop or math.hypot(*imu['values']['angular_rate_radps'])>=cfg['max_angular_rate_radps']:
        return release(state),False,surface
    speed=math.hypot(*g['values']['velocity_ned_mps'])
    speed_limit=cfg['release_speed_mps' if held else 'acquire_speed_mps']
    # A credible speed releases immediately. A rejected fix needs corroboration.
    rejected=state.outcome=='outlier_rejected'
    if (speed>=speed_limit and not (held and rejected)) or (not held and rejected):
        return release(state),False,surface
    angles=tuple(ahrs['values'][key] for key in ('heading_deg','pitch_deg','roll_deg'))
    count=0;motion_time=-1.
    if held:
        z=to_ecef(g['values']['latitude_deg'],g['values']['longitude_deg'],g['values']['altitude_ellipsoid_m'])
        z=project(tuple(a-b for a,b in zip(z,state.anchor)),state.axes)
        radius=max(cfg['minimum_position_gate_m'],cfg['position_gate_sigma']*math.sqrt(sum(g['uncertainty']['position_variance_ned_m2'][:2])))
        moved=math.hypot(*(a-b for a,b in zip(z[:2],old.stationary_position[:2])))>radius
        variance=ahrs['uncertainty'].get('attitude_variance_deg2',[0.,0.,0.])
        turned=bool(old.stationary_attitude and any(abs((a-b+180)%360-180)>
            max(cfg['attitude_gate_deg'],cfg['attitude_gate_sigma']*math.sqrt(2*max(0,v)))
            for a,b,v in zip(angles,old.stationary_attitude,variance)))
        if moved or turned or rejected:
            # Distinct sensor observations, never repeated World/HTTP ticks.
            # Sustained disagreement overrides a stuck onboard parked report.
            motion_time=(g if moved or rejected else ahrs)['sample_time']+offset
            count=old.stationary_motion_count+(motion_time>old.stationary_motion_time+1e-6)
            if count>=cfg['motion_confirm_samples']:
                return release(state),False,surface
    # Freeze the first consistent candidate during confirmation as well.
    since=old.stationary_since if held else state.time
    position=old.stationary_position if held else state.position
    attitude=old.stationary_attitude if held else state.attitude
    if attitude is None:
        # Cold connection with delayed AHRS: disclose the true sample age,
        # rather than inventing north/level while awaiting a fresh packet.
        attitude=(angles[0]%360,*angles[1:])
        state=replace(state,attitude_time=ahrs['sample_time']+offset,seen_attitude=ahrs['sample_time']+offset)
    # Holding is not an independent measurement; never collapse uncertainty.
    previous_cov=old.covariance if old else state.covariance
    covariance=tuple((max(c[0],o[0]),0.,max(c[2],.001)) for c,o in zip(state.covariance,previous_cov))
    state=replace(state,position=position,velocity=(0.,0.,0.),attitude=attitude,covariance=covariance,
                  stationary_since=since,stationary_position=position,stationary_attitude=attitude,
                  stationary_motion_count=count,stationary_motion_time=motion_time)
    confirmed=state.time-since>=cfg['acquire_seconds']
    return state,confirmed and all(fresh(item) for item in (g,vehicle,imu,ahrs)),surface
