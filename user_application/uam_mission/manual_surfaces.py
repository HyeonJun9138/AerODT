"""Validated session scene geometry; native runtime resolves deck contacts."""
import math


def departure_surface(plan, altitude, value):
    """Use the same validated deck for initial feet and native contact planes.

    A scenario's cached DEM altitude can differ from the rendered deck sent
    with this session. Resolve this before creating a runtime, never by moving
    an already flying body or overriding its contact flag.
    """
    point = plan['legs'][0]['path'][0]
    origin = [point[0], point[1], altitude]
    decks = contact_decks(value, origin)
    datum = point[3] if len(point) > 3 else ''
    identifier = datum[5:] if isinstance(datum, str) and datum.startswith('deck:') else None
    identifier = identifier or plan.get('request', {}).get('from_vertiport')
    if not identifier:
        return origin, decks
    matches = [i for i, item in enumerate(value) if item.get('id') == identifier]
    if len(matches) != 1:
        raise ValueError('출발 데크가 아직 준비되지 않았습니다. 지도 로딩 후 다시 시작하세요')
    index = matches[0]
    ring, _ = decks[index]
    inside = False
    for (x, y), (a, b) in zip(ring, ring[1:] + ring[:1]):
        if (y > 0) != (b > 0) and 0 < (a-x)*(-y)/(b-y)+x:
            inside = not inside
    if not inside:
        raise ValueError('출발 GATE가 데크 내부에 없습니다. 버티포트 배치를 확인하세요')
    origin[2] = value[index]['height_m']
    return origin, contact_decks(value, origin)


def contact_decks(value, origin):
    if not isinstance(value,list) or len(value)>128:
        raise ValueError('contact_decks: at most 128 decks')
    lon,lat,alt=origin
    decks=[]
    for item in value:
        if not isinstance(item,dict):raise ValueError('deck object required')
        height=item.get('height_m');ring=item.get('outline')
        if isinstance(height,bool) or not isinstance(height,(int,float)) or not math.isfinite(height) or not -500<=height<=10000:
            raise ValueError('deck height')
        if not isinstance(ring,list) or not 3<=len(ring)<=256:raise ValueError('deck outline')
        points=[]
        for point in ring:
            if not isinstance(point,list) or len(point)!=2 or any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for x in point):
                raise ValueError('deck point')
            east=(point[0]-lon)*math.pi/180*6371000*math.cos(math.radians(lat))
            north=(point[1]-lat)*math.pi/180*6371000
            if abs(east)>1e6 or abs(north)>1e6:raise ValueError('deck distance')
            points.append((north,east))
        area=abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:]+points[:1])))/2
        if not 1<=area<=1e7:raise ValueError('deck area')
        decks.append((points,alt-height))
    return decks
