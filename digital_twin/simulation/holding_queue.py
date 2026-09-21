"""PSU-owned waiting reservations, separate from observed aircraft state."""
import math
from digital_twin.model_library.terminal_paths import segment_distance


def relative(origin, point):
    return ((point[0]-origin[0])*111320.,
            (point[1]-origin[1])*111320.*math.cos(math.radians(origin[0])), point[2]-origin[2])


def nearby(a, b, horizontal, vertical):
    n,e,z = relative(a,b)
    return math.hypot(n,e) < horizontal and abs(z) < vertical


def clip_height(a,b,low,high):
    if abs(b[2]-a[2])<1e-8:
        return (a,b) if low<=a[2]<=high else None
    times=sorted(((low-a[2])/(b[2]-a[2]),(high-a[2])/(b[2]-a[2])))
    first,last=max(0.,times[0]),min(1.,times[1])
    if first>last:return None
    return tuple(tuple(a[i]+(b[i]-a[i])*t for i in range(3)) for t in (first,last))


def blocks_leg(point,start,end,horizontal,vertical):
    p=relative(start,point);delta=relative(start,end)
    part=clip_height((0.,0.,0.),delta,p[2]-vertical,p[2]+vertical)
    return bool(part and segment_distance(part[0][:2],part[1][:2],p[:2],p[:2])<horizontal)


def paused_return_yields(own, own_observation, other, observation, horizontal, vertical):
    """Only a settled follower yields its future merge to a nearer returner.

    Rank with actual observations, never a hypothetical detour origin. Keep
    the leader's claim for new arrivals, and the full claim while still braking.
    No physical observation, pad reservation or approach authority is released.
    """
    if not own or own.get('state')!='returning' or own_observation is None:
        return False
    if not nearby(own['rejoin'],other['rejoin'],horizontal,vertical):
        return False
    velocity=observation.get('velocity',(0.,0.,0.))
    if math.hypot(*velocity[:2])>=1 or abs(velocity[2])>=.3:
        return False
    if not nearby(observation['position'],other['return_hold'],8.,3.):
        return False
    def priority(claim, observed):
        return (math.dist((0.,0.,0.),relative(claim['rejoin'],observed['position'])),
                claim.get('assigned_s',0.),claim['owner'])
    return priority(own,own_observation)<priority(other,observation)


def positions(anchor, inbound, horizontal=120., vertical=45.):
    """Six fixed side bays per level; add levels before going farther away.

    The anchor is a route-defined approach entry, never the querying aircraft.
    Bays have an approach-side identity shared by all users of this entry.
    """
    n,e,_ = relative(anchor,inbound)
    length = math.hypot(n,e)
    n,e = (n/length,e/length) if length > 1 else (1.,0.)
    spacing = max(300.,horizontal*1.5)
    lateral = max(480.,horizontal*2)
    scale = 111320.*math.cos(math.radians(anchor[0]))
    for level in range(6):
        for along in (0.,spacing,-spacing):
            for side in (1,-1):
                north,east = n*along-e*lateral*side,e*along+n*lateral*side
                point = (anchor[0]+north/111320.,anchor[1]+east/scale,
                         anchor[2]+level*max(120.,vertical*2))
                yield f'{"R" if side==1 else "L"}{int(along/spacing)+2}-H{level+1}',point


class HoldingQueue:
    def __init__(self):
        self.reservations = {}

    def reserve(self, owner, port, candidates, rejoin, now, horizontal, vertical, allowed):
        if owner in self.reservations:
            return self.reservations[owner]
        for name,target in candidates:
            if any(nearby(target,r['target'],horizontal,vertical) for r in self.reservations.values()):
                continue
            if any(blocks_leg(target,r['target'],r['rejoin'],horizontal,vertical) or
                   blocks_leg(r['target'],target,rejoin,horizontal,vertical)
                   for r in self.reservations.values()):
                continue
            if not allowed(target):
                continue
            r = dict(owner=owner,port=port,slot=name,target=tuple(target),rejoin=tuple(rejoin),
                     state='assigned',assigned_s=now,move_start=None)
            self.reservations[owner] = r
            return r
        return None

    def release(self, owner):
        return self.reservations.pop(owner,None)

    def transfer_clear(self, owner, position, target, observations, horizontal, vertical, lookahead):
        """Screen the whole transfer against observed traffic and moving claims.

        A stopped pre-existing infringement may only diverge. Assigned but
        stationary bays reserve their endpoint, not an imaginary moving path.
        Settled followers may yield their unflown merge leg to a nearer return,
        but still protect the observed body, commanded stop and residual speed.
        Equal full claims otherwise let paused returns lock a shared entry.
        """
        delta = relative(position,target)
        own=self.reservations.get(owner)
        own_observation=next((o for o in observations if o['owner']==owner),None)
        for other in observations:
            if other['owner']==owner:
                continue
            p = relative(position,other['position'])
            velocity = other.get('velocity',(0.,0.,0.))
            claim = self.reservations.get(other['owner'])
            moving = claim and claim['state'] in ('moving','returning')
            paused = moving and claim.get('return_hold') is not None
            observed_end = tuple(p[i]+velocity[i]*lookahead for i in range(3))
            if paused:
                # Both envelopes are needed while braking/settling: the fixed
                # stop alone misses overshoot, velocity alone misses return to it.
                ends = (relative(position,claim['return_hold']), observed_end)
                if not paused_return_yields(own,own_observation,claim,other,horizontal,vertical):
                    ends += (relative(position,claim['rejoin']),)
            elif moving:
                ends = (relative(position,claim.get('movement_target',claim['rejoin'] if claim['state']=='returning' else claim['target'])),)
            else:
                ends = (observed_end,)
            for end in ends:
                if min(p[2],end[2])-max(0.,delta[2]) >= vertical or min(0.,delta[2])-max(p[2],end[2]) >= vertical:
                    continue
                portion=clip_height((0.,0.,0.),delta,min(p[2],end[2])-vertical,max(p[2],end[2])+vertical)
                if portion is None:continue
                closest = segment_distance(portion[0][:2],portion[1][:2],p[:2],end[:2])
                distance = math.hypot(*p[:2])
                if distance < horizontal and abs(p[2]) < vertical:
                    # Do not cross another aircraft's altitude while escaping an
                    # overlap. A level lateral escape can increase horizontal gap.
                    if (math.hypot(*velocity[:2])>1 or abs(velocity[2])>.3 or moving or
                        closest<distance-.05 or math.dist(delta[:2],p[:2])<horizontal+10 or
                        abs(delta[2])>1):
                        return False
                elif closest < horizontal:
                    return False
        for key,r in self.reservations.items():
            if key==owner:
                continue
            p=relative(position,r['target'])
            portion=clip_height((0.,0.,0.),delta,p[2]-vertical,p[2]+vertical)
            if portion:
                closest=segment_distance(portion[0][:2],portion[1][:2],p[:2],p[:2])
                initial=math.hypot(*p[:2])
                if closest<horizontal and not (initial<horizontal and closest>=initial-.05 and
                        math.dist(delta[:2],p[:2])>=horizontal+10):
                    return False
        return True
