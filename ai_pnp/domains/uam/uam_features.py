"""Delivered ctrl_00 feature coordinates; read-only adaptation, not guidance.

The training projection deliberately uses 111320 m/degree, not geodesic ENU.
Native SimpleFlight does not expose every training feature. Derived/assumed
inputs must travel with the warning below and are not measured controller data.
"""
import math

ORIGIN_LAT, ORIGIN_LON = 37.552, 127.0
METRES_PER_DEGREE = 111320.0
LONGITUDE_SCALE = METRES_PER_DEGREE * math.cos(math.radians(ORIGIN_LAT))
INPUT_QUALITY = ('연구용 비교: 각속도는 자세 이력의 차분, 바람은 0 가정, 유효 속도 명령은 '
                 '현재 임무 구간의 계획 속도로 근사합니다. 횡방향 오차는 활성 구간 기준입니다. '
                 '시간 입력은 실제 출발 후 경과 초입니다. '
                 '학습 제어기 ctrl_00과 현재 SimpleFlight의 차이가 있어 실제 비행 예측 정확도는 별도 검증이 필요합니다.')


def local_position(latitude, longitude, altitude):
    return ((longitude-ORIGIN_LON)*LONGITUDE_SCALE,
            (latitude-ORIGIN_LAT)*METRES_PER_DEGREE, altitude)


def local_to_ecef(point):
    x, y, altitude = point
    lat = math.radians(ORIGIN_LAT + y/METRES_PER_DEGREE)
    lon = math.radians(ORIGIN_LON + x/LONGITUDE_SCALE)
    f = 1/298.257223563
    e2 = f*(2-f)
    n = 6378137/math.sqrt(1-e2*math.sin(lat)**2)
    return ((n+altitude)*math.cos(lat)*math.cos(lon),
            (n+altitude)*math.cos(lat)*math.sin(lon),
            (n*(1-e2)+altitude)*math.sin(lat))


def route_points(intent):
    # Intent already starts at the pilot's active target, never nearest route point.
    return [dict(zip(('x','y','z'), local_position(*p.end))) for p in intent.waypoints]


def feature_sample(entity, intent, elapsed, previous=None):
    if not intent.waypoints or entity.velocity_ecef_mps is None or entity.heading_deg is None:
        return None
    try:
        x,y,z = local_position(entity.latitude_deg,entity.longitude_deg,entity.altitude_m)
        lat,lon = math.radians(entity.latitude_deg),math.radians(entity.longitude_deg)
        vx,vy,vz = entity.velocity_ecef_mps
        east = -math.sin(lon)*vx+math.cos(lon)*vy
        north = -math.sin(lat)*math.cos(lon)*vx-math.sin(lat)*math.sin(lon)*vy+math.cos(lat)*vz
        up = math.cos(lat)*math.cos(lon)*vx+math.cos(lat)*math.sin(lon)*vy+math.sin(lat)*vz
        roll,pitch,yaw = float(entity.roll_deg or 0),float(entity.pitch_deg or 0),(entity.heading_deg+90)%360-180
        yr,pr = math.radians(yaw),math.radians(pitch)
        cy,sy,cp,sp = math.cos(yr),math.sin(yr),math.cos(pr),math.sin(pr)
        u = east*cp*cy-north*cp*sy+up*sp
        v = -east*sy-north*cy
        w = -east*sp*cy+north*sp*sy+up*cp
        rates = (0.,0.,0.)
        if previous is not None and 1e-6 < entity.state_time-previous[0] <= 2.5:
            dt = entity.state_time-previous[0]
            rates = tuple(((a-b+180)%360-180)/dt for a,b in zip((roll,pitch,yaw),previous[1][4:7]))
        target = intent.waypoints[0]
        tx,ty,tz = local_position(*target.end)
        ax,ay,_ = local_position(*target.start)
        dx,dy = tx-x,ty-y
        length = math.hypot(tx-ax,ty-ay)
        # The delivered RNP signal is positive left / negative right.
        cross = ((y-ay)*(tx-ax)-(x-ax)*(ty-ay))/length if length>1e-6 else 0.
        result = (float(elapsed),x,y,z,roll,pitch,yaw,u,v,w,*rates,0.,0.,0.,
                  float(target.speed_mps),cross,dx*cy-dy*sy,-dx*sy-dy*cy,tz-z)
        return result if all(math.isfinite(n) for n in result) else None
    except (TypeError, ValueError, OverflowError):
        return None
