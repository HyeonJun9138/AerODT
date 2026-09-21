"""Receiver-side inverse calibration. Never reads Physical truth or rewrites raw records."""
from copy import deepcopy
import math
from digital_twin.model_library.sensor_calibration import MODEL as B


def calibrate_record(record):
    if record.get('calibration_applied'):return record
    sensors=record.get('aligned_sensors',record['packet']['sensors'])
    tagged=[name for name,s in sensors.items() if 'calibration_profile' in s]
    if not tagged:return record
    result=dict(sensors);floor=B['numerical_variance_floor']
    for name in tagged:
        raw=sensors[name]
        if raw['calibration_profile']!=B['model_id']:raise ValueError('Unknown calibration profile')
        item=deepcopy(raw);v=item['values'];u=item['uncertainty']
        if name=='gnss':
            # Longitude uses the recovered latitude, not the biased latitude.
            latitude=v['latitude_deg']-B['north_m']/B['metres_per_degree']
            v['longitude_deg']-=B['east_m']/(B['metres_per_degree']*math.cos(math.radians(latitude)))
            v['latitude_deg']=latitude;v['altitude_ellipsoid_m']-=B['height_m']
            u.update(position_variance_ned_m2=[floor]*3,velocity_variance_m2ps2=[floor]*3)
        elif name=='ahrs':
            for key in ('heading_deg','pitch_deg','roll_deg'):v[key]-=B[key]
            v['heading_deg']%=360;u['attitude_variance_deg2']=[floor]*3
        elif name=='barometer':
            v['altitude_ellipsoid_m']-=B['height_m']
            v['pressure_pa']=101325*(1-v['altitude_ellipsoid_m']/44330)**5.255
            u['altitude_variance_m2']=floor
        result[name]=item
    return dict(record,aligned_sensors=result,calibration_applied=True)


def calibration_detail(record):
    sensors=record.get('aligned_sensors',record['packet']['sensors']);g=sensors.get('gnss')
    base={'model_id':B['model_id'],'label':B['label'],'rule':dict(B),'truth_error_m':None,
        'basis':'sensor_observation_epoch','random_noise_recoverable':False}
    if not g:return dict(base,status='waiting')
    if 'calibration_profile' not in g:return dict(base,status='stochastic')
    try:fixed=calibrate_record(record)['aligned_sensors']
    except ValueError:return dict(base,status='unsupported')
    at=g['sample_time'];raw=g['values'];v=fixed['gnss']['values']
    def point(values):return {k:values[k] for k in ('latitude_deg','longitude_deg','altitude_ellipsoid_m')}
    return dict(base,status='applied',sample_time=at,sequence=g['sequence'],
        receiver_sample_time=at+record.get('clock_offset_s',0),
        raw=point(raw),corrected=point(v),removed_position_bias_m=math.sqrt(sum(B[k]**2 for k in ('north_m','east_m','height_m'))),
        heading={'raw':sensors['ahrs']['values']['heading_deg'],'corrected':fixed['ahrs']['values']['heading_deg'],
                 'sample_time':sensors['ahrs']['sample_time']} if sensors.get('ahrs',{}).get('calibration_profile')==B['model_id'] else None)
