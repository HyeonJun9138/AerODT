"""Explicitly synthetic teaching fixture; never registers entities in the live World."""
from functools import lru_cache
import json
import math
from pathlib import Path
from digital_twin.simulation.physical_sensors import PhysicalSensors
from digital_twin.live_twin.domains.uam.sensor_calibration import calibration_detail
from digital_twin.model_library.sensor_calibration import MODEL as B


@lru_cache(maxsize=1)
def example():
    root=Path(__file__).resolve().parents[6]
    model=json.loads((root/'digital_twin/model_library/packages/physical_uam_sensors/v1/model.json').read_text(encoding='utf-8'))
    sampler=PhysicalSensors(dict(model,sensor_profile=B['model_id']));points=[];errors=[]
    for i in range(41):
        north=i*1.5;east=12*math.sin(i/9);height=120+2*math.sin(i/10)
        state=dict(latitude_deg=37.55+north/111320,longitude_deg=127+east/(111320*math.cos(math.radians(37.55))),
            altitude_m=height,velocity_ned_mps=[7.5,0,0],heading_deg=20,pitch_deg=0,roll_deg=0,
            tilt_deg=80,rotor_radps=230,grounded=False,route_target_index=0)
        sampler.sample(state,i*.2,1000+i*.2,'cruise')
        d=calibration_detail({'packet':{'sensors':sampler.latest}})
        reference={k:state[k] for k in ('latitude_deg','longitude_deg')};reference['altitude_ellipsoid_m']=height
        v=d['corrected'];error=math.sqrt(((v['latitude_deg']-reference['latitude_deg'])*111320)**2+
            ((v['longitude_deg']-reference['longitude_deg'])*111320*math.cos(math.radians(reference['latitude_deg'])))**2+
            (v['altitude_ellipsoid_m']-height)**2)
        errors.append(error);points.append(dict(d,reference=reference,truth_error_m=error))
    return {'source':'synthetic_example','label':'예시 데이터 · 실제 운항 아님','points':points,
        'max_reconstruction_error_m':max(errors),'rule':dict(B),
        'note':'참조값은 이 예시의 검증 전용입니다. 실제 Live 보정은 센서 관측과 알려진 규칙만 사용합니다.'}
