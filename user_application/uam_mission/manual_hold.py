"""Two holds a pilot can put on a button: keep this height, keep this spot.

Neither of these is the route autopilot. That one follows the flight plan, and
only in fixed-wing cruise above 28 m/s within 2 km of the route. These are the
holds you reach for when you want the aircraft to stop doing something for a
moment -- and they work where a pilot actually wants them, which is a multirotor
sitting over a vertiport waiting for a slot.

Both are written as an outer loop on the same stick the pilot writes, rather
than through the native guidance input. That input is the fixed-wing
heading/altitude/speed one the route autopilot uses; a multirotor takes a stick
and nothing else. Writing the stick has a second virtue: a hold comes off the
instant the pilot moves that stick, which is the one thing every pilot expects a
hold to do, and it needs no agreement with the native side to be true.

Nothing here commands more than a third of the available authority and every
loop is rate-limited before it is applied, so a hold that is badly trimmed --
engaged in a climb, say -- drifts and recovers rather than diverging. The gains
are deliberately soft for the same reason: a hold that takes a few seconds to
settle is a hold; one that snaps is a hazard.
"""
import math

ALTITUDE, POSITION, OFF = 'altitude', 'position', 'off'

# How far a stick must move before the pilot is taken to be flying again. The
# same figure the route autopilot uses to decide it has been overridden.
RELEASE = .18
# How far the throttle must move to count as the pilot taking the height back.
# Smaller than RELEASE because a throttle is not spring-centred: it sits where
# it was left, so any movement at all is deliberate.
THROTTLE_RELEASE = .06
# The most of the stick a hold may use. A hold keeps an aircraft where it is; it
# does not fly it. A gentle loop that drifts is a great deal better than a
# confident one that has a sign wrong.
AUTHORITY = .35
# What a hold is allowed to ask the aircraft for.
CLIMB_LIMIT = 2.0          # m/s
# What a position hold may ask for across the ground, and what it may still be
# engaged at. Both are set by what the aircraft can actually do: measured, a
# third of the stick -- all this loop is allowed -- buys 2.6 degrees of body
# pitch and about 1.5 m/s. Promising more would be a hold that says it has the
# aircraft and then watches it sail on.
GROUND_SPEED_LIMIT = 2.0   # m/s
ENGAGE_SPEED_LIMIT = 8.0   # m/s
# Collective per m/s of climb-rate error, and how fast the trim walks under it.
# Measured rather than guessed: a tenth of the lever is worth about thirteen
# metres a second on this airframe, so unity gain is near 0.008 and anything
# like the 0.08 this started at oscillates instead of settling.
CLIMB_GAIN = .010
CLIMB_TRIM = .008

EARTH_M = 6371000.0


def clamp(value, low, high):
    return max(low, min(high, value))


class ManualHold:
    """One hold at a time. `update` returns the command to fly, or None to pass
    the pilot's own through untouched."""

    def __init__(self):
        self.mode = OFF
        self.reason = 'HOLD OFF'
        self.target = None
        self.trim = 0.0
        self.entry_throttle = 0.0

    # ---- what the wire and the panel see -------------------------------
    def snapshot(self):
        return {'mode': self.mode, 'engaged': self.mode != OFF, 'message': self.reason,
                'altitude_m': self.target[2] if self.target else None}

    @property
    def engaged(self):
        return self.mode != OFF

    # ---- engaging and letting go ---------------------------------------
    def engage(self, mode, sample, command, *, ground_locked=False):
        if mode not in (ALTITUDE, POSITION):
            raise ValueError('고도 유지 또는 위치 유지만 걸 수 있습니다')
        if ground_locked:
            raise ValueError('지상 작업 중에는 유지를 걸 수 없습니다')
        if not sample or not sample.get('airborne'):
            raise ValueError('비행 중에만 유지를 걸 수 있습니다')
        if max(abs(command.get(key, 0) or 0) for key in ('roll', 'pitch', 'yaw')) > RELEASE:
            raise ValueError('스틱을 중립으로 놓은 뒤 유지를 거세요')
        if mode == POSITION:
            # A wing cannot hold a spot, and neither can a machine still tilted
            # most of the way into being one.
            if sample.get('mode') != 'multirotor' or (sample.get('tilt_deg') or 0) > 15:
                raise ValueError('위치 유지는 멀티로터 모드에서만 걸 수 있습니다')
            if (sample.get('speed_mps') or 0) > ENGAGE_SPEED_LIMIT:
                raise ValueError(f'{ENGAGE_SPEED_LIMIT:.0f} m/s 이하로 줄인 뒤 위치 유지를 거세요')
        at = sample['position']
        self.target = (at['latitude'], at['longitude'], at['altitude_m'])
        self.entry_throttle = clamp(float(command.get('throttle') or 0), 0, 1)
        self.trim = self.entry_throttle
        self.mode = mode
        self.reason = '고도 유지' if mode == ALTITUDE else '위치 유지'
        return self.reason

    def disable(self, reason='HOLD OFF'):
        self.mode = OFF
        self.target = None
        self.reason = reason

    # ---- the loops ------------------------------------------------------
    def update(self, sample, command, dt):
        """The command to fly this step, or None to leave the pilot's alone."""
        if self.mode == OFF or not sample or not self.target:
            return None
        if not sample.get('airborne'):
            self.disable('착지 · 유지 해제')
            return None
        mode = sample.get('mode')
        if self.mode == POSITION and mode != 'multirotor':
            self.disable('비행 모드 전환 · 유지 해제')
            return None
        # Which axes this hold owns, and therefore which ones the pilot touching
        # means they have taken the aircraft back.
        sticks = ('roll', 'pitch') if self.mode == POSITION else () if mode == 'multirotor' else ('pitch',)
        if any(abs(command.get(key, 0) or 0) > RELEASE for key in sticks):
            self.disable('직접 조종 입력 · 유지 해제')
            return None
        owns_throttle = self.mode == POSITION or mode == 'multirotor'
        if owns_throttle and abs(float(command.get('throttle') or 0) - self.entry_throttle) > THROTTLE_RELEASE:
            self.disable('스로틀 조작 · 유지 해제')
            return None
        step = clamp(float(dt) if dt and math.isfinite(dt) else .05, .004, .5)
        flown = dict(command)
        wanted = self._climb(sample, step)
        if owns_throttle:
            flown['throttle'] = self._collective(sample, wanted, step)
        else:
            # A wing changes height with the elevator, and the pilot keeps the
            # throttle -- which is how a fixed-wing altitude hold is flown.
            flown['pitch'] = clamp(self._climb_pitch(sample, wanted), -AUTHORITY, AUTHORITY)
        if self.mode == POSITION:
            forward, right = self._translate(sample)
            # Forward is a nose-down stick: the keyboard's ArrowUp, which moves
            # the aircraft forward, sends pitch -1.
            flown['pitch'] = clamp(-forward, -AUTHORITY, AUTHORITY)
            flown['roll'] = clamp(right, -AUTHORITY, AUTHORITY)
        return flown

    def _climb(self, sample, step):
        """The climb rate this hold wants, in m/s, positive up."""
        error = self.target[2] - (sample['position'].get('altitude_m') or 0)
        return clamp(.35 * error, -CLIMB_LIMIT, CLIMB_LIMIT)

    def _climb_rate(self, sample):
        velocity = sample.get('velocity_ned_mps')
        return -float(velocity[2]) if isinstance(velocity, (list, tuple)) and len(velocity) == 3 else 0.0

    def _collective(self, sample, wanted, step):
        error = wanted - self._climb_rate(sample)
        raw = self.trim + CLIMB_GAIN * error
        output = clamp(raw, 0.0, 1.0)
        # The trim is where the collective has to sit to stay level, and only
        # the aircraft knows it: engaging in a climb hands over one far too high.
        # Measured on the shipped airframe, hover is about 0.135 of the lever and
        # a tenth of lever is worth some thirteen metres a second of climb, so a
        # hold engaged at 0.6 has to travel a very long way -- which is why the
        # trim is free to go anywhere in the range rather than being penned in
        # around where the pilot left it.
        #
        # It stops integrating while the collective is against a stop, because a
        # trim that keeps winding up there only has to be unwound afterwards,
        # and that unwinding is exactly the overshoot a pilot reads as hunting.
        if raw == output:
            self.trim = clamp(self.trim + CLIMB_TRIM * error * step, 0.0, 1.0)
        return output

    def _climb_pitch(self, sample, wanted):
        # Nose up is a positive stick: the keyboard's ArrowDown sends pitch +1.
        return .12 * (wanted - self._climb_rate(sample))

    def _translate(self, sample):
        """Forward and rightward stick, in the aircraft's own frame."""
        at = sample['position']
        latitude = at.get('latitude') or 0
        north = (self.target[0] - latitude) * math.pi / 180 * EARTH_M
        east = ((self.target[1] - (at.get('longitude') or 0)) * math.pi / 180
                * EARTH_M * math.cos(math.radians(latitude)))
        heading = math.radians(sample.get('heading_deg') or 0)
        cos, sin = math.cos(heading), math.sin(heading)
        velocity = sample.get('velocity_ned_mps')
        vn, ve = (float(velocity[0]), float(velocity[1])) if isinstance(velocity, (list, tuple)) and len(velocity) == 3 else (0.0, 0.0)
        pairs = []
        for error, speed in ((north * cos + east * sin, vn * cos + ve * sin),
                             (-north * sin + east * cos, -vn * sin + ve * cos)):
            wanted = clamp(.28 * error, -GROUND_SPEED_LIMIT, GROUND_SPEED_LIMIT)
            pairs.append(.25 * (wanted - speed))
        return pairs[0], pairs[1]
