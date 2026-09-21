"""Versioned Physical UAM wire adapter. No vehicle dynamics or Twin state."""
import math
import re
import time
import httpx

SENSORS={'gnss','ahrs','barometer','imu','vehicle'}


def validate_packet(p, now):
    def number(value,low=-1e12,high=1e12):
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:
            raise ValueError('Invalid sensor number')
        return value
    def vector(value,size=3,low=-1e8,high=1e8):
        if not isinstance(value,list) or len(value)!=size:raise ValueError('Invalid sensor vector')
        for v in value:number(v,low,high)
    if not isinstance(p,dict) or p.get('schema_version')!=1 or p.get('message_type')!='aerodt.uam.sensor_packet':raise ValueError('Unknown UAM protocol')
    if p.get('provenance')!='physical_emulation':raise ValueError('Unknown input provenance')
    for key in ('process_id','aircraft_id','mission_id'):
        if not isinstance(p.get(key),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',p[key]):raise ValueError('Invalid UAM identifier')
    if not isinstance(p.get('sequence'),int) or isinstance(p['sequence'],bool) or not 1<=p['sequence']<2**53:raise ValueError('Invalid packet sequence')
    if 'aircraft_sequence' in p and (not isinstance(p['aircraft_sequence'],int) or isinstance(p['aircraft_sequence'],bool) or not 1<=p['aircraft_sequence']<2**53):raise ValueError('Invalid aircraft sequence')
    for key in ('source_started_at','mission_started_at','sent_time'):number(p[key],0,now+2)
    if 'published_time' in p:number(p['published_time'],p['source_started_at'],now+2)
    if 'flight_elapsed_s' in p:number(p['flight_elapsed_s'],0,172800)
    if 'plan_time' in p:number(p['plan_time'],0,1e11)
    if p['sent_time']<now-30:raise ValueError('Expired packet')
    if not p['source_started_at']<=p['mission_started_at']<=p['sent_time']:raise ValueError('Invalid source clock')
    if not isinstance(p.get('sensors'),dict) or set(p['sensors'])-SENSORS:raise ValueError('Unknown sensor')
    if not isinstance(p.get('samples'),list) or len(p['samples'])>100:raise ValueError('Oversized samples')
    for item in [*p['sensors'].values(),*p['samples']]:
        name=item.get('sensor_id')
        if name not in SENSORS:raise ValueError('Unknown sensor')
        if 'calibration_profile' in item and item['calibration_profile']!='known_bias_v1':
            raise ValueError('Unknown calibration profile')
        number(item['sample_time'],p['mission_started_at'],p['sent_time']+.001)
        if 'sample_monotonic_s' in item:number(item['sample_monotonic_s'],0,172800)
        number(item['sequence'],1,2**53);number(item['nominal_hz'],.1,1000)
        v=item['values']; u=item['uncertainty']
        if name=='gnss':
            if item['frame']!='WGS84_ellipsoid/NED':raise ValueError('Invalid GNSS frame')
            number(v['latitude_deg'],-89,89);number(v['longitude_deg'],-180,180);number(v['altitude_ellipsoid_m'],-1000,30000)
            vector(v['velocity_ned_mps'],low=-200,high=200)
            vector(u['position_variance_ned_m2'],low=.000001,high=1e6)
            vector(u['velocity_variance_m2ps2'],low=.000001,high=1e6)
        elif name=='ahrs':
            if item['frame']!='body_FRD_to_NED':raise ValueError('Invalid attitude frame')
            for k in ('heading_deg','pitch_deg','roll_deg'):number(v[k],-720,720)
        elif name=='barometer':
            if item['frame']!='WGS84_ellipsoid_calibrated':raise ValueError('Invalid altitude datum')
            number(v['altitude_ellipsoid_m'],-1000,30000);number(u['altitude_variance_m2'],.000001,1e6)
        elif name=='imu':
            if item['frame']!='body_FRD':raise ValueError('Invalid IMU frame')
            vector(v['specific_force_mps2']);vector(v['angular_rate_radps'])
        else:
            number(v['tilt_deg'],-10,180);number(v['rotor_radps'],0,10000)
            if not isinstance(v['flight_phase'],str) or len(v['flight_phase'])>32:raise ValueError('Invalid phase')
    intent=p.get('intent',{})
    if not isinstance(intent.get('waypoints'),list) or len(intent['waypoints'])>1000:raise ValueError('Invalid intent')
    number(intent['target_index'],0,100000)
    for point in intent['waypoints']:
        for end in ('start','end'):
            vector(point[end]);number(point[end][0],-89,89);number(point[end][1],-180,180);number(point[end][2],-1000,30000)
        number(point['speed_mps'],0,200)
        if not isinstance(point.get('phase'),str) or len(point['phase'])>32:raise ValueError('Invalid route phase')
    if any(not isinstance(v,(float,int)) or not math.isfinite(v) or abs(v)>10000 for v in intent.get('policy',{}).values()):raise ValueError('Invalid intent policy')
    for key in ('max_speed_mps','climb_rate_mps','descent_rate_mps','landing_rate_mps','approach_horizontal_speed_mps','approach_brake_mps2'):
        if key in intent.get('policy',{}):number(intent['policy'][key],.01,200)
    ref=p.get('surface_reference')
    if ref:number(ref['altitude_m'],-1000,10000)
    if 'operations' in p:
        operations=p['operations']
        if not isinstance(operations,dict):raise ValueError('Invalid operations')
        command=operations.get('instruction',{})
        if not isinstance(command,dict):raise ValueError('Invalid instruction')
        if 'ground_waiting' in operations and not isinstance(operations['ground_waiting'],bool):
            raise ValueError('Invalid ground waiting flag')
        for key in ('action','reason','route_id'):
            if key in command and (not isinstance(command[key],str) or len(command[key])>1000):
                raise ValueError('Invalid ground instruction text')
        for key in ('stop_distance_m','distance_m','wait_seconds','updated_s'):
            if key in command:number(command[key],0,1e11)
        blocked=command.get('blocked_by',[])
        if not isinstance(blocked,list) or len(blocked)>128 or any(not isinstance(v,str) or len(v)>100 for v in blocked):
            raise ValueError('Invalid ground blockers')
    return p


async def fetch_packets(client, url, *, after=0, process='',shard=0,shards=1):
    # A deployment-controlled endpoint; browser users cannot turn it into an arbitrary proxy.
    params={'after':after,'process':process,'delivery':'latest'}
    if shards>1:params.update(shard=shard,shards=shards)
    async with client.stream('GET',url.rstrip('/')+'/api/v1/telemetry',params=params,timeout=3) as response:
        response.raise_for_status(); chunks=[]; size=0
        async for chunk in response.aiter_bytes():
            size+=len(chunk)
            if size>8*1024*1024:raise ValueError('Physical batch exceeds 8 MB')
            chunks.append(chunk)
    import json
    body=json.loads(b''.join(chunks))
    if body.get('schema_version')!=1 or not isinstance(body.get('packets'),list) or len(body['packets'])>256:raise ValueError('Invalid UAM batch')
    coalesced=body.get('coalesced_packets',0)
    if not isinstance(coalesced,int) or not 0<=coalesced<=2048:raise ValueError('Invalid coalesced packet count')
    return body


async def sample_clock(client,url,process):
    """Use the fastest of three small status reads, avoiding bulk bootstrap cost."""
    samples=[]
    for _ in range(3):
        started=time.monotonic();requested=time.time()
        response=await client.get(url.rstrip('/')+'/api/v1/status',timeout=3)
        received=time.time();elapsed=time.monotonic()-started;response.raise_for_status();body=response.json()
        if abs((received-requested)-elapsed)>.1:continue
        source_time=body.get('server_time')
        if (body.get('process_id')!=process or not isinstance(source_time,(float,int))
                or not math.isfinite(source_time) or abs(received-source_time)>300):
            raise ValueError('Physical clock generation or timestamp mismatch')
        samples.append({'requested':requested,'received':received,'source_time':source_time,
                        'telemetry_shards':4 if body.get('telemetry_shards')==4 else 1})
    if not samples:raise ValueError('Local clock changed during calibration')
    return min(samples,key=lambda sample:sample['received']-sample['requested'])
