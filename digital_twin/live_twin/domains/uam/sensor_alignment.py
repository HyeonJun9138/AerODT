"""Bounded, time-aligned analytical navigation with covariance and innovation gates."""
import math
from dataclasses import replace
from digital_twin.contracts.sensor_estimation import SensorPosterior,SensorEstimation
from digital_twin.model_library.uam_alignment import MODEL,validate
from foundation.geodesy import to_ecef,from_ecef
from digital_twin.live_twin.domains.uam.sensor_covariance import axes_at,project,expand,predict,correct
from digital_twin.live_twin.domains.uam.ground_sensor_constraints import constrain
from digital_twin.live_twin.domains.uam.sensor_calibration import calibrate_record

def distance(a,b):return math.sqrt(sum((x-y)**2 for x,y in zip(a,b)))

def motion_time(sensor):
    value=sensor.get('sample_monotonic_s') if sensor else None
    return float(value) if type(value) in (int,float) and math.isfinite(value) and value>=0 else None

def motion_delta(current,previous,utc_delta):
    # Emulated physics may run slower than wall time under host overload.
    # Sensor velocity is per physics second; do not treat a scheduling pause
    # as seconds of unobserved flight when testing a new GNSS innovation.
    delta=current-previous if current is not None and previous is not None else None
    return delta if delta is not None and 0<delta<=max(.05,utc_delta*2) else utc_delta

def align_posterior_clock(state,offset):
    """Translate time coordinates, never count a held sensor as another fix."""
    delta=offset-state.clock_offset_s
    if not delta:return state
    changes={name:getattr(state,name)+delta for name in ('time','seen_gnss')}
    for name in ('attitude_time','seen_attitude','stationary_motion_time'):
        value=getattr(state,name)
        if value>=0:changes[name]=value+delta
    if state.candidate is not None:changes['candidate_time']=state.candidate_time+delta
    if state.stationary_since is not None:changes['stationary_since']=state.stationary_since+delta
    return replace(state,clock_offset_s=offset,**changes)

def measurement(record,settings,axes):
    p=record['packet'];s=record.get('aligned_sensors',p['sensors']);g=s['gnss'];v=g['values'];offset=record.get('clock_offset_s',0)
    observed=g['sample_time']+offset
    height=v['altitude_ellipsoid_m'];variances=list(g['uncertainty']['position_variance_ned_m2'])
    velocity=project(expand(v['velocity_ned_mps'],axes_at(v['latitude_deg'],v['longitude_deg'])),axes)
    vr=tuple(max(.001,x) for x in g['uncertainty']['velocity_variance_m2ps2'])
    clock=max(0,record.get('clock_uncertainty_s',0))
    baro=s.get('barometer');used=False;skew=0.
    if baro:
        skew=baro['sample_time']-g['sample_time']
        if abs(skew)<=settings['max_alignment_skew_s']:
            b=baro['values']['altitude_ellipsoid_m']+v['velocity_ned_mps'][2]*skew
            bv=max(.01,baro['uncertainty']['altitude_variance_m2'])+vr[2]*skew*skew
            gv=max(.01,variances[2])
            if abs(b-height)<max(15,settings['gate_sigma']*math.sqrt(gv+bv)):
                height=(height/gv+b/bv)/(1/gv+1/bv);variances[2]=1/(1/gv+1/bv);used=True
    r=tuple(max(.01,x)+speed*speed*clock*clock for x,speed in zip(variances,velocity))
    return observed,to_ecef(v['latitude_deg'],v['longitude_deg'],height),velocity,r,vr,used,abs(skew)

def aligned_state(record,target,previous=None,settings=None):
    try:record=calibrate_record(record)
    except ValueError:return None
    cfg=validate(settings or {});signature=tuple(sorted(cfg.items()))
    p=record['packet'];s=record.get('aligned_sensors',p['sensors']);gnss=s.get('gnss');offset=record.get('clock_offset_s',0)
    signature+=tuple((name,item['calibration_profile']) for name,item in sorted(s.items()) if 'calibration_profile' in item)
    raw_time=gnss['sample_time']+offset if gnss else None
    same=bool(previous and previous.entity_id=='physical:'+p['aircraft_id'] and previous.continuity_id==record['continuity'])
    old=previous.estimation_state if same else None
    reset=bool(previous and (not same or old and old.signature!=signature))
    if old and old.signature!=signature:old=None
    if old is not None:old=align_posterior_clock(old,offset)
    valid_measurement=bool(gnss and raw_time<=target+.05 and target-raw_time<=MODEL['expiry_seconds'])
    if old is None and not valid_measurement:return None
    if old is None:
        g=gnss['values'];axes=axes_at(g['latitude_deg'],g['longitude_deg'])
        observed,anchor,velocity,r,vr,used,skew=measurement(record,cfg,axes)
        state=SensorPosterior(anchor,axes,(0.,0.,0.),velocity,tuple((x,0.,y) for x,y in zip(r,vr)),
            observed,observed,None,-1.,-1.,barometer_used=used,alignment_skew_s=skew,signature=signature,
            outcome='filtered' if cfg['enabled'] else 'aligned',clock_offset_s=offset,motion_time_s=motion_time(gnss))
    else:state=old
    phase=s.get('vehicle',{}).get('values',{}).get('flight_phase',p.get('intent',{}).get('phase',''))
    q=MODEL['process_variance'].get(phase,MODEL['process_variance']['default'])
    if old is not None and valid_measurement and raw_time>old.seen_gnss+1e-6:
        observed,fixed,velocity,r,vr,used,skew=measurement(record,cfg,old.axes)
        z=project(tuple(x-y for x,y in zip(fixed,old.anchor)),old.axes)
        motion=motion_time(gnss)
        prior,prior_v,cov=predict(old.position,old.velocity,old.covariance,motion_delta(motion,old.motion_time_s,observed-old.time),q)
        innovation=distance(prior,z)
        nis=sum((x-y)**2/(c[0]+rv) for x,y,c,rv in zip(z,prior,cov,r))
        velocity_nis=sum((x-y)**2/(c[2]+rv) for x,y,c,rv in zip(velocity,prior_v,cov,vr))
        rejected=cfg['enabled'] and (nis>3*cfg['gate_sigma']**2 or velocity_nis>3*cfg['gate_sigma']**2 or math.hypot(*velocity)>120)
        if rejected:
            consistent=old.candidate is not None and observed-old.candidate_time<=1.5 and distance(
                z,tuple(x+v*motion_delta(motion,old.candidate_motion_time_s,observed-old.candidate_time) for x,v in zip(old.candidate,velocity)))<max(5,3*math.sqrt(sum(r)))
            hits=old.candidate_count+1 if consistent else 1
            state=replace(old,seen_gnss=observed,gnss_outliers=old.gnss_outliers+1,candidate=z,
                candidate_time=observed,candidate_motion_time_s=motion,candidate_count=hits,outcome='outlier_rejected',innovation_m=innovation,
                correction_m=innovation,barometer_used=used,alignment_skew_s=skew)
            if observed-old.time>cfg['coast_seconds'] and hits>=MODEL['reacquire_samples'] and math.hypot(*velocity)<=120:
                state=replace(state,position=z,velocity=velocity,covariance=tuple((x,0.,y) for x,y in zip(r,vr)),
                    time=observed,motion_time_s=motion,outcome='reacquired',candidate=None,candidate_count=0,correction_m=0.,display_epoch=old.display_epoch+1)
                reset=True
        else:
            if cfg['enabled']:position,v,cov=correct(prior,prior_v,cov,z,velocity,r,vr)
            else:position,v,cov=z,velocity,tuple((x,0.,y) for x,y in zip(r,vr))
            # A host scheduling pause is not an unobserved flight. Preserve a
            # consistent posterior when the native sensor clock only advanced
            # a normal sample interval; wall-clock freshness still expires below.
            continuity_gap=max(.6,cfg['coast_seconds'])
            gap=(observed-old.time>continuity_gap and
                 motion_delta(motion,old.motion_time_s,observed-old.time)>continuity_gap)
            # A new valid fix after a long outage is a new display continuity,
            # not a line connecting across an unobserved movement.
            if gap:position,v,cov=z,velocity,tuple((x,0.,y) for x,y in zip(r,vr));reset=True
            state=replace(old,position=position,velocity=v,covariance=cov,time=observed,motion_time_s=motion,seen_gnss=observed,
                candidate=None,candidate_count=0,barometer_used=used,alignment_skew_s=skew,innovation_m=innovation,
                correction_m=distance(position,z),outcome='reacquired' if gap else 'filtered' if cfg['enabled'] else 'aligned',
                display_epoch=old.display_epoch+int(gap))
    ahrs=s.get('ahrs')
    if ahrs:
        at=ahrs['sample_time']+offset;values=ahrs['values'];angles=(values['heading_deg']%360,values['pitch_deg'],values['roll_deg'])
        if at<=target+.05 and target-at<=2 and at>state.seen_attitude+1e-6:
            delta=tuple((a-b+180)%360-180 for a,b in zip(angles,state.attitude)) if state.attitude else (0.,0.,0.)
            gap=at-state.attitude_time
            if cfg['enabled'] and state.attitude is not None and gap<=2 and max(abs(x) for x in delta)>max(5,MODEL['attitude_max_rate_dps']*gap):
                state=replace(state,seen_attitude=at,attitude_outliers=state.attitude_outliers+1)
            else:
                gain=1-math.exp(-max(0,gap)/cfg['attitude_seconds'])
                if cfg['enabled'] and state.attitude is not None and gap<=2:
                    angles=tuple(b+gain*d for b,d in zip(state.attitude,delta));angles=(angles[0]%360,*angles[1:])
                state=replace(state,attitude=angles,attitude_time=at,seen_attitude=at)
    state,stationary,surface_constrained=constrain(state,old,record,target,cfg['enabled'])
    age=max(0,target-state.time)
    if age>MODEL['expiry_seconds']:return None
    limit=cfg['coast_seconds']
    def sigma(dt):
        _,_,cv=predict(state.position,state.velocity,state.covariance,dt,q)
        return math.sqrt(max(0,cv[0][0]+cv[1][0])),math.sqrt(max(0,cv[2][0]))
    if max(sigma(limit))>cfg['max_sigma_m']:
        low,high=0.,limit
        for _ in range(12):
            mid=(low+high)/2
            if max(sigma(mid))>cfg['max_sigma_m']:high=mid
            else:low=mid
        limit=low
    dt=min(age,limit);position,velocity,_=predict(state.position,state.velocity,state.covariance,dt,q)
    fixed=tuple(x+y for x,y in zip(state.anchor,expand(position,state.axes)));vel=expand(velocity,state.axes)
    frozen=age>limit+1e-6 or max(sigma(0))>cfg['max_sigma_m']
    expected=1/max(1,p.get('report_hz',10))
    mode='frozen' if frozen else 'outlier_rejected' if state.outcome=='outlier_rejected' else 'coasting' if age>max(.6,expected*1.5) else state.outcome
    hsig,vsig=sigma(age);attitude_age=max(0,target-state.attitude_time)
    diagnostics=SensorEstimation(mode,hsig,vsig,state.correction_m,state.innovation_m,age,
        max(0,target-raw_time) if raw_time is not None else age,dt,state.gnss_outliers,state.attitude_outliers,
        state.barometer_used,state.alignment_skew_s,attitude_age,max(0,record.get('clock_uncertainty_s',0)),stationary,surface_constrained)
    # Missing AHRS is not a measurement of north/level. Retain the last accepted
    # pose, while the public age and stale status disclose its lack of freshness.
    return dict(position=fixed,velocity=vel,geodetic=from_ecef(fixed),attitude=state.attitude,
        observed=state.time,valid_until=state.time+limit,quality='stale' if frozen else 'valid',
        diagnostics=diagnostics,posterior=state,discontinuity=reset)
