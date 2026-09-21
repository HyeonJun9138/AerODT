"""Explicitly synthetic, bounded GRU inputs derived from provider reports.

Resampling changes cadence, not information content. No generated point is
published as an observation or written back to the World. Accuracy measured
on the training data does not establish accuracy on these corrected inputs.
"""
import math

from digital_twin.live_twin.domains.aircraft.gru_prediction import predict_path
from foundation.geodesy import velocity_ecef

MAX_AGE_SECONDS = 45.0


def corrected_window(reports, target, max_age=MAX_AGE_SECONDS):
    if not reports or not math.isfinite(target) or max_age <= 0:
        return None
    times = [target - (15-i)*.2 for i in range(16)]
    if times[0] < reports[0][0] or not 0 <= target-reports[-1][0] < max_age:
        return None
    if any(not all(math.isfinite(x) for x in (t, *p, *v)) or len(p)!=3 or len(v)!=3
           for t, p, v in reports):
        return None
    if any(b[0] <= a[0] or b[0]-a[0] > max_age for a,b in zip(reports,reports[1:])):
        return None
    positions = []
    for moment in times:
        position = None
        for a, b in zip(reports, reports[1:]):
            if a[0] <= moment <= b[0]:
                share = (moment-a[0])/(b[0]-a[0])
                position = tuple(x+(y-x)*share for x,y in zip(a[1],b[1]))
                break
        if position is None:
            t,p,v = reports[-1]
            position = tuple(x+speed*(moment-t) for x,speed in zip(p,v))
        positions.append(position)
    return positions, times


def provider_trajectory(entity, reports, model, target, max_age, seconds):
    if (not reports or reports[-1][0] != entity.observation_time
            or entity.quality == 'stale' or entity.discontinuity or seconds <= 0
            or (entity.valid_until is not None and target >= entity.valid_until)):
        return None
    window = corrected_window(reports, target, min(max_age, MAX_AGE_SECONDS))
    if window is None:
        return None
    positions, times = window
    origin = positions[-1]
    # Orthogonal ENU basis at the selected aircraft; model coordinates are not ECEF.
    basis = (velocity_ecef(entity.latitude_deg, entity.longitude_deg, 90, 1, 0),
             velocity_ecef(entity.latitude_deg, entity.longitude_deg, 0, 1, 0),
             velocity_ecef(entity.latitude_deg, entity.longitude_deg, 0, 0, 1))
    local = [[sum((p[i]-origin[i])*axis[i] for i in range(3)) for axis in basis] for p in positions]
    result = predict_path(model, local, times)
    points = [[target, *origin]]
    for t, p in zip(result['times_s'], result['position_enu_m']):
        fixed = [origin[i]+sum(p[j]*basis[j][i] for j in range(3)) for i in range(3)]
        if not all(math.isfinite(x) for x in fixed):
            return None
        points.append([t,*fixed])
    span = min(15., seconds)
    return {'schema_version':1, 'kind':'aircraft', 'reference_frame':'ecef_m',
            'derivation':'estimated', 'span_seconds':span, 'valid_until':target+15.,
            'points':points, 'summary':{'model':'gru_direct_v1_1',
                'model_label':'GRU · 보정 입력 기반', 'basis':'provider_corrected', 'seconds':span,
                'requested_seconds':seconds, 'covered_seconds':15.,
                'observation_age_seconds':target-reports[-1][0], 'truncated':seconds>15},
            'note':'보정 입력 기반 GRU 예측 · 관측 사이 보간 / 마지막 관측 이후 등속 외삽. '
                   '실측 5 Hz 데이터가 아니며 이 입력에 대한 예측 정확도는 검증되지 않았습니다.'}
