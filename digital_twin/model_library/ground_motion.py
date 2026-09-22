"""Conservative taxi preview geometry and timing, not tyre/contact dynamics.

Corner trimming is at most 2 m along either adjoining centreline. Each
quadratic curve stays inside their convex hull; endpoints are unchanged.
The operator still needs to validate the aircraft's swept clearance.
"""
import math

ACCEL_MPS2 = 0.6
LATERAL_MPS2 = 0.5
CORNER_TRIM_M = 2.0
YAW_RATE_DPS = 10.0


def turn_delta(a, b):
    return (b - a + 180) % 360 - 180


# Profiles already built, by the path and speed they were built for. A deck
# has a few dozen stand-to-pad paths and a day's routes taxi them thousands
# of times; the profile of a path is the same each time. The path and the
# profile are handed out as fresh containers, since `align_start` and
# `prepare_pushback` write into the profile they are given.
_PROFILES = {}
_PROFILE_KEEP = 4096


def prepare(points, max_speed, hold_s):
    key = (tuple(tuple(point) for point in points), float(max_speed), float(hold_s))
    found = _PROFILES.get(key)
    if found is None:
        if len(_PROFILES) >= _PROFILE_KEEP:
            _PROFILES.clear()
        found = _PROFILES[key] = _prepare(points, max_speed, hold_s)
    path, profile, distance, duration = found
    # Lists too: `prepare_pushback` writes into the heading list it is given.
    copied = {key: (list(value) if isinstance(value, list) else value) for key, value in profile.items()} if profile is not None else None
    return list(path), copied, distance, duration


def _prepare(points, max_speed, hold_s):
    if len(points)<2 or max_speed<=0:
        return points, None, 0.0, hold_s
    lat,lon=points[0]; scale=111194.92664455874; east=scale*math.cos(math.radians(lat))
    xy=[((p[1]-lon)*east,(p[0]-lat)*scale) for p in points]
    clean=[xy[0]]
    for p in xy[1:]:
        if math.dist(p,clean[-1])>.001:clean.append(p)
    if len(clean)<2:return points,None,0.0,hold_s
    curved=[clean[0]]
    for a,b,c in zip(clean,clean[1:],clean[2:]):
        left,right=math.dist(a,b),math.dist(b,c)
        trim=min(CORNER_TRIM_M,left*.24,right*.24)
        u=((b[0]-a[0])/left,(b[1]-a[1])/left)
        v=((c[0]-b[0])/right,(c[1]-b[1])/right)
        if u[0]*v[0]+u[1]*v[1]>.9999:
            curved.append(b);continue
        before=(b[0]-u[0]*trim,b[1]-u[1]*trim)
        after=(b[0]+v[0]*trim,b[1]+v[1]*trim)
        curved.append(before)
        for i in range(1,25):
            t=i/24
            curved.append(tuple((1-t)**2*before[k]+2*t*(1-t)*b[k]+t*t*after[k] for k in (0,1)))
    curved.append(clean[-1])
    dense=[curved[0]]
    for a,b in zip(curved,curved[1:]):
        d=math.dist(a,b)
        if d<.001:continue
        count=max(1,math.ceil(d/2))
        dense.extend(tuple(a[k]+(b[k]-a[k])*i/count for k in (0,1)) for i in range(1,count+1))
    if len(dense)==2:
        dense.insert(1,tuple((dense[0][k]+dense[1][k])/2 for k in (0,1)))
    distances=[0.0]
    for a,b in zip(dense,dense[1:]):distances.append(distances[-1]+math.dist(a,b))
    bearings=[math.degrees(math.atan2(b[0]-a[0],b[1]-a[1]))%360 for a,b in zip(dense,dense[1:])]
    headings=[bearings[0]]+[ (a+turn_delta(a,b)/2)%360 for a,b in zip(bearings,bearings[1:])]+[bearings[-1]]
    speeds=[float(max_speed)]*len(dense);speeds[0]=speeds[-1]=0.0
    for i in range(1,len(dense)-1):
        a,b,c=dense[i-1:i+2]; ab,bc,ac=math.dist(a,b),math.dist(b,c),math.dist(a,c)
        cross=abs((b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]))
        curvature=2*cross/(ab*bc*ac) if ab*bc*ac>1e-12 else 0
        if curvature>1e-8:speeds[i]=min(max_speed,math.sqrt(LATERAL_MPS2/curvature))
        elif (b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1])<0:
            speeds[i]=0.0
    # Limit translation, not heading after translation. Both use the same arc length.
    for i in range(len(dense)-1):
        turn=abs(turn_delta(headings[i],headings[i+1]))
        if turn>1e-8:
            cap=YAW_RATE_DPS*(distances[i+1]-distances[i])/turn
            speeds[i]=min(speeds[i],cap);speeds[i+1]=min(speeds[i+1],cap)
    for i in range(1,len(speeds)):
        speeds[i]=min(speeds[i],math.sqrt(speeds[i-1]**2+2*ACCEL_MPS2*(distances[i]-distances[i-1])))
    for i in range(len(speeds)-2,-1,-1):
        speeds[i]=min(speeds[i],math.sqrt(speeds[i+1]**2+2*ACCEL_MPS2*(distances[i+1]-distances[i])))
    times=[hold_s/2]
    for i in range(1,len(speeds)):
        times.append(times[-1]+2*(distances[i]-distances[i-1])/(speeds[i]+speeds[i-1]))
    output=[(lat+y/scale,lon+x/east) for x,y in dense]
    output[0],output[-1]=points[0],points[-1]
    return output,{'times_s':times,'distances_m':distances,'speeds_mps':speeds,'headings_deg':headings},distances[-1],times[-1]+hold_s/2


def heading_at(profile, fraction, seconds):
    """Spatial tangent interpolation, never a delayed heading filter."""
    headings=profile.get('headings_deg')
    if not headings:return None
    alignment=profile.get('heading_alignment')
    if alignment and seconds<alignment['duration_s']:
        t=max(0.0,seconds)/alignment['duration_s'];ease=t*t*(3-2*t)
        return (alignment['from_deg']+turn_delta(alignment['from_deg'],headings[0])*ease)%360
    import bisect
    distances=profile['distances_m'];distance=max(0,min(1,fraction))*distances[-1]
    i=min(len(headings)-2,max(0,bisect.bisect_right(distances,distance)-1))
    f=(distance-distances[i])/(distances[i+1]-distances[i])
    return (headings[i]+turn_delta(headings[i],headings[i+1])*f)%360


def align_start(leg, heading):
    """Reserve stopped time to align after actual touchdown, before taxi motion."""
    profile=leg.get('ground_motion')
    if not profile or not profile.get('headings_deg'):return
    duration=max(.1,1.5*abs(turn_delta(heading,profile['headings_deg'][0]))/YAW_RATE_DPS)
    profile['heading_alignment']={'from_deg':heading,'duration_s':duration}
    extra=max(0,duration+1-profile['times_s'][0])
    profile['times_s']=[t+extra for t in profile['times_s']]
    leg['duration_s']=math.ceil((leg['duration_s']+extra)*10)/10


def at(profile, seconds):
    times,distances,speeds=(profile[k] for k in ('times_s','distances_m','speeds_mps'))
    if seconds<=times[0]:return 0.0,0.0
    if seconds>=times[-1]:return 1.0,0.0
    import bisect
    i=bisect.bisect_right(times,seconds)-1
    dt=seconds-times[i]; span=times[i+1]-times[i]
    acceleration=(speeds[i+1]-speeds[i])/span
    distance=distances[i]+speeds[i]*dt+.5*acceleration*dt*dt
    return distance/distances[-1],speeds[i]+acceleration*dt


def time_at_distance(profile, distance):
    """Nominal progress clock, excluding traffic waits (inverse of ``at``)."""
    import bisect
    marks, speeds, times = (profile[k] for k in ('distances_m','speeds_mps','times_s'))
    distance = max(0.0, min(marks[-1], distance))
    if distance >= marks[-1]:
        return times[-1]
    i = min(len(marks)-2, max(0, bisect.bisect_right(marks,distance)-1))
    ds = distance-marks[i]
    a = (speeds[i+1]**2-speeds[i]**2)/(2*(marks[i+1]-marks[i]))
    speed = math.sqrt(max(0.0, speeds[i]**2+2*a*ds))
    dt = 2*ds/(speeds[i]+speed) if speeds[i]+speed > 1e-12 else 0.0
    return times[i]+dt


def advance(profile, distance, speed, stop_distance, speed_limit, seconds):
    """Advance the existing taxi kinematics under a route-distance permission.

    All limits are physical arc lengths, not an elapsed-time pause. The forward
    acceleration and future curve/stop braking envelopes share the same bound.
    A permission inside the existing braking distance is an explicit failure;
    it must not silently teleport the aircraft to a holding point.
    """
    import bisect
    values = (distance, speed, stop_distance, speed_limit, seconds)
    if not all(math.isfinite(v) and v >= 0 for v in values):
        raise ValueError('finite nonnegative ground motion values required')
    marks, speeds = profile['distances_m'], profile['speeds_mps']
    end = min(marks[-1], stop_distance)
    if distance > end+1e-6 or speed*speed > 2*ACCEL_MPS2*(end-distance)+1e-5:
        raise ValueError('movement permission is inside the braking distance')
    remaining_time = seconds
    while remaining_time > 1e-9:
        dt = min(.05, remaining_time)
        remaining_time -= dt
        remaining = max(0.0,end-distance)
        if remaining < 1e-8 and speed < 1e-5:
            return end,0.0
        # Finish the last constant-deceleration interval exactly.
        if speed > 0 and speed/ACCEL_MPS2 <= dt and remaining <= speed*speed/(2*ACCEL_MPS2)+1e-7:
            return end,0.0
        i = min(len(marks)-2,max(0,bisect.bisect_right(marks,distance)-1))
        cap = min(speed_limit, max(speeds[i],speeds[i+1]))
        # v_next^2 <= v_target^2 + 2*a*(ds - (v+v_next)*dt/2).
        # Enforce at every future speed knot, including the permission endpoint.
        bound = 2*ACCEL_MPS2*remaining
        for j in range(i+1,len(marks)):
            if marks[j] > end: break
            reach = 2*ACCEL_MPS2*(marks[j]-distance)
            # Marks never decrease and a speed squared is never negative, so
            # once the distance term alone reaches the bound no later knot can
            # lower it: the min over the rest of the path is already known.
            if reach >= bound: break
            bound = min(bound, speeds[j]**2+reach)
        a_dt = ACCEL_MPS2*dt
        safe = max(0.0,(-a_dt+math.sqrt(max(0.0,a_dt*a_dt+4*(bound-a_dt*speed))))/2)
        next_speed = min(speed+a_dt,cap,safe)
        # Envelope continuity guarantees this up to numerical roundoff.
        next_speed = max(speed-a_dt,next_speed,0.0)
        moved = (speed+next_speed)*dt/2
        if moved > remaining+1e-6:
            raise ValueError('braking envelope failed to contain ground movement')
        distance += min(moved,remaining)
        speed = next_speed
    return distance,speed


def prepare_pushback(points, heading, max_speed, hold_s, *, side=1):
    """Low-speed reverse quarter turn, stop, then forward quarter turn.

    Kinematic research manoeuvre, not a tug/tyre simulation. Caller must check
    the swept path against deck bounds/obstacles and authorize ground traffic.
    Only a nose-in start and a sufficiently long straight stem are eligible.
    """
    if len(points)<2:return None
    lat,lon=points[0];scale=111194.92664455874;east=scale*math.cos(math.radians(lat))
    xy=[((p[1]-lon)*east,(p[0]-lat)*scale) for p in points]
    end=next((p for p in xy[1:] if math.hypot(*p)>1),None)
    if end is None:return None
    length=math.hypot(*end);ux,uy=end[0]/length,end[1]/length
    bearing=math.degrees(math.atan2(ux,uy))%360
    if abs(turn_delta(heading,(bearing+180)%360))>8:return None
    # Dense prepared paths still describe the same initial straight stem.
    join=1
    for i,p in enumerate(xy[1:],1):
        along=p[0]*ux+p[1]*uy;cross=p[0]*uy-p[1]*ux
        if abs(cross)>.15 or along<length-.01:break
        length=along;join=i
    if length<10:return None
    straight=min(6.,length*.25)
    radius=min(6.,(length-straight-2)/2)
    side=1 if side>=0 else -1
    def point(x,y):
        e=x*ux+y*uy*side;n=x*uy-y*ux*side
        return (lat+n/scale,lon+e/east)
    rear=[points[0],point(straight,0)]
    for i in range(1,37):
        t=math.pi/2*i/36
        rear.append(point(straight+radius*math.sin(t),radius*(1-math.cos(t))))
    forward=[rear[-1]]
    for i in range(1,37):
        t=math.pi/2*i/36
        forward.append(point(straight+2*radius-radius*math.cos(t),radius-radius*math.sin(t)))
    forward.extend(points[join:])
    rear_path,a,da,ta=prepare(rear,min(1.5,max_speed),hold_s)
    front_path,b,db,tb=prepare(forward,max_speed,0)
    if not a or not b:return None
    a['headings_deg']=[(v+180)%360 for v in a['headings_deg']]
    # Exact body heading agrees across the zero-speed gear-change cusp.
    cusp=(bearing-90*side)%360
    a['headings_deg'][-1]=b['headings_deg'][0]=cusp
    a['headings_deg'][0]=heading%360
    profile={
        'distances_m':a['distances_m']+[da+v for v in b['distances_m'][1:]],
        'times_s':a['times_s']+[a['times_s'][-1]+v for v in b['times_s'][1:]],
        'speeds_mps':a['speeds_mps']+b['speeds_mps'][1:],
        'headings_deg':a['headings_deg']+b['headings_deg'][1:],
        'pushback_end_m':da,
    }
    return rear_path+front_path[1:],profile,da+db,profile['times_s'][-1]+hold_s/2
