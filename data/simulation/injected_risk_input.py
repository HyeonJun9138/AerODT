"""Validate viewer test tracks, without publishing them into the World."""
import math
from digital_twin.contracts.live import TwinEntity
from foundation.geodesy import from_ecef


def read_injected_tracks(body, snapshot, own_id):
    if not isinstance(body,dict) or body.get('epoch')!=snapshot.epoch:
        raise ValueError('주입 시험의 실행 시점이 변경되었습니다.')
    if not any(e.entity_id==own_id for e in snapshot.entities):
        raise ValueError('기준 기체가 없습니다.')
    tracks=body.get('tracks')
    if not isinstance(tracks,list) or len(tracks)>8:
        raise ValueError('주입 시험 표적은 최대 8개입니다.')
    result=[];seen=set();reserved={e.entity_id for e in snapshot.entities}
    for track in tracks:
        if not isinstance(track,dict):raise ValueError('표적 형식 오류')
        identifier=track.get('entity_id');kind=track.get('kind');samples=track.get('samples')
        if (not isinstance(identifier,str) or not identifier.startswith('intruder:') or len(identifier)>160
                or identifier in seen or identifier in reserved or kind not in ('uam','drone','bird')):
            raise ValueError('주입 표적 식별자 오류')
        if not isinstance(samples,list) or not 1<=len(samples)<=20:raise ValueError('표적 이력 범위 오류')
        previous=-math.inf
        for row in samples:
            if (not isinstance(row,list) or len(row)!=4 or
                    not all(isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x) for x in row)):
                raise ValueError('표적 좌표 오류')
            t,*p=row
            if not previous<t<=snapshot.state_time or t<snapshot.state_time-10 or not 6.2e6<=math.hypot(*p)<=6.5e6:
                raise ValueError('표적 시각 또는 좌표 범위 오류')
            previous=t
        seen.add(identifier)
        t,*p=samples[-1];lat,lon,alt=from_ecef(p)
        entity=TwinEntity(entity_id=identifier,name=f'{kind} (주입 시험)',kind=kind,
            position_ecef_m=tuple(p),velocity_ecef_mps=None,latitude_deg=lat,longitude_deg=lon,
            altitude_m=alt,heading_deg=None,state_time=t,observation_time=t,received_time=t,
            orbit_epoch=None,derivation='injected',quality='nominal',source='intruder',
            model_id='injected_test',visual_asset_id='',provenance='injected',valid_until=t+2.5)
        result.append((entity,tuple(tuple(row) for row in samples)))
    return result
