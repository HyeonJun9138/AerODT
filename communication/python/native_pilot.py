"""C ABI v1 adapter. Handles are private, single-owner, and explicitly closed."""
import ctypes as C
import math
import os
from pathlib import Path


class NativePilotLibrary:
    def __init__(self, path=None):
        root = Path(__file__).resolve().parents[2]
        path = path or os.environ.get("AERODT_UAM_PILOT_LIBRARY")
        if not path:
            names = ("aerodt_uam_pilot_v9.dll", "libaerodt_uam_pilot_v9.so", "aerodt_uam_pilot_v8.dll", "libaerodt_uam_pilot_v8.so", "aerodt_uam_pilot_v7.dll", "libaerodt_uam_pilot_v7.so", "aerodt_uam_pilot_v6.dll", "libaerodt_uam_pilot_v6.so",
                     "aerodt_uam_pilot.dll", "libaerodt_uam_pilot.so")
            path = next((root / "project_support/build/aerodt" / preset / "bin" / name
                         for preset in ("windows-release", "linux-release", "windows-debug")
                         for name in names
                         if (root / "project_support/build/aerodt" / preset / "bin" / name).is_file()), None)
        if path is None:
            raise RuntimeError("다중 비행 물리 엔진을 먼저 빌드하세요: aerodt_uam_pilot")
        self.lib = C.CDLL(str(Path(path).resolve()))
        lib = self.lib
        lib.aerodt_pilot_abi.restype = C.c_int
        self.abi = lib.aerodt_pilot_abi()
        if self.abi not in (1, 2, 3, 4, 5, 6, 7):
            raise RuntimeError("지원하지 않는 native pilot ABI")
        lib.aerodt_pilot_error.restype = C.c_char_p
        lib.aerodt_pilot_create.argtypes = [C.POINTER(C.c_double), C.c_int, C.c_double, C.c_double]
        lib.aerodt_pilot_create.restype = C.c_void_p
        lib.aerodt_pilot_step.argtypes = [C.c_void_p, C.c_double, C.POINTER(C.c_double), C.POINTER(C.c_double)]
        lib.aerodt_pilot_step.restype = C.c_int
        lib.aerodt_pilot_destroy.argtypes = [C.c_void_p]
        lib.aerodt_pilot_destroy.restype = None
        # ABI 2 accepts the guidance numbers. An older library still flies, with
        # the values it was compiled with; the caller is told so it can say as
        # much rather than silently ignoring what the operator set.
        self.surface_reader=getattr(lib,'aerodt_pilot_control_surfaces',None)
        if self.surface_reader:
            self.surface_reader.argtypes=[C.c_void_p,C.POINTER(C.c_double),C.c_int];self.surface_reader.restype=C.c_int
        self.tunable = self.abi >= 2
        self.terminal_guidance_capable = self.abi >= 5
        self.arrival_reassignment_capable = self.abi >= 6
        if self.arrival_reassignment_capable:
            lib.aerodt_pilot_replace_arrival.argtypes = [C.c_void_p,C.c_int,C.c_int,
                C.POINTER(C.c_double),C.c_int,C.c_double]
            lib.aerodt_pilot_replace_arrival.restype = C.c_int
        if self.terminal_guidance_capable:
            lib.aerodt_pilot_set_landing_yaw.argtypes = [C.c_void_p, C.c_double]
            lib.aerodt_pilot_set_landing_yaw.restype = C.c_int
            lib.aerodt_pilot_guidance_status.argtypes = [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)]
            lib.aerodt_pilot_guidance_status.restype = C.c_char_p
        self.traffic_capable = self.abi >= 4
        if self.traffic_capable:
            lib.aerodt_pilot_traffic.argtypes = [C.c_void_p, C.c_double, C.c_double]
            lib.aerodt_pilot_traffic.restype = C.c_int
        if self.tunable:
            lib.aerodt_pilot_create_tuned.argtypes = [C.POINTER(C.c_double), C.c_int, C.c_double,
                                                      C.c_double, C.POINTER(C.c_double), C.c_int]
            lib.aerodt_pilot_create_tuned.restype = C.c_void_p

    def error(self):
        return RuntimeError((self.lib.aerodt_pilot_error() or b"native pilot failed").decode("utf-8", "replace"))

    def create(self, waypoints, yaw, landing_yaw, tuning=None):
        return NativePilot(self, waypoints, yaw, landing_yaw, tuning)


# The order the native side reads the guidance numbers in. It is the contract:
# a shorter array leaves the rest at what the pilot was written with, so a value
# added here later does not break a caller that has not heard of it.
TUNING_ORDER = ("approach_brake_mps2", "approach_gain", "reverse_speed_mps",
                "reverse_transition_s", "reverse_margin_m", "reverse_brake_span",
                "climb_rate_mps", "descent_rate_mps", "landing_rate_mps",
                "hover_capture_m", "hover_settle_s", "descent_settle_s",
                "hold_speed_mps", "wing_stall_mps", "wing_recover_mps",
                "approach_horizontal_speed_mps", "wing_altitude_gain")


def tuning_array(values):
    """The named numbers as the flat array the ABI takes, or None for defaults.

    The array has to be a prefix of the order, so a name the caller left out
    ends it: everything from there on stays at what the pilot was compiled
    with, which is what a shorter array means on the other side.
    """
    numbers = []
    for name in TUNING_ORDER:
        if not values or name not in values:
            break
        value = values[name]
        numbers.append(1.0 if value is True else 0.0 if value is False else float(value))
    return numbers or None


class NativePilot:
    def __init__(self, library, waypoints, yaw, landing_yaw, tuning=None):
        if not 1 <= len(waypoints) <= 4096 or any(len(p) != 6 for p in waypoints):
            raise ValueError("invalid waypoint array")
        self.library, self.handle = library, None
        values = [float(value) for point in waypoints for value in point]
        if not all(math.isfinite(x) for x in [*values, yaw, landing_yaw]):
            raise ValueError("non-finite flight profile")
        data = (C.c_double * len(values))(*values)
        if tuning and len(tuning) > 15 and library.abi < 3:
            raise RuntimeError("접근 수평속도 적용을 위해 native pilot을 재빌드하고 서버를 재시작하세요")
        if tuning and library.tunable:
            if not all(math.isfinite(x) for x in tuning):
                raise ValueError("non-finite pilot tuning")
            numbers = (C.c_double * len(tuning))(*(float(x) for x in tuning))
            self.handle = library.lib.aerodt_pilot_create_tuned(
                data, len(waypoints), yaw, landing_yaw, numbers, len(tuning))
        else:
            self.handle = library.lib.aerodt_pilot_create(data, len(waypoints), yaw, landing_yaw)
        if not self.handle:
            raise library.error()
        self.output = (C.c_double * 17)()

    def control_surfaces(self):
        out=(C.c_double*4)()
        reader=self.library.surface_reader
        return tuple(out) if self.handle and reader and reader(self.handle,out,4) else None

    def set_landing_yaw(self, degrees):
        """Change arrival heading before final alignment; never reset runtime."""
        if not self.handle:
            raise RuntimeError("pilot is closed")
        if not math.isfinite(degrees):
            raise ValueError("landing yaw must be finite degrees")
        if not self.library.terminal_guidance_capable:
            raise RuntimeError("착륙 방위 갱신에는 native pilot ABI 5 이상이 필요합니다")
        result = self.library.lib.aerodt_pilot_set_landing_yaw(self.handle, degrees)
        if result < 0:
            raise self.library.error()
        return bool(result)

    def replace_arrival(self, expected_index, first, waypoints, landing_yaw):
        if not self.handle:
            raise RuntimeError('pilot is closed')
        if not self.library.arrival_reassignment_capable:
            return False
        if not 2 <= len(waypoints) <= 4096 or any(len(p)!=6 for p in waypoints):
            raise ValueError('invalid arrival waypoints')
        values=[float(v) for p in waypoints for v in p]
        if not all(math.isfinite(v) for v in [*values,landing_yaw]):
            raise ValueError('non-finite arrival update')
        data=(C.c_double*len(values))(*values)
        result=self.library.lib.aerodt_pilot_replace_arrival(self.handle,expected_index,first,
            data,len(waypoints),landing_yaw)
        if result<0:raise self.library.error()
        return bool(result)

    def guidance_status(self):
        """Last actual native guidance branch, not inferred from observed speed."""
        if not self.handle:
            raise RuntimeError("pilot is closed")
        if not self.library.terminal_guidance_capable:
            return {"available": False, "reason": "unsupported", "waypoint_index": None,
                    "landing_yaw_mutable": None}
        waypoint, mutable = C.c_int(), C.c_int()
        reason = self.library.lib.aerodt_pilot_guidance_status(
            self.handle, C.byref(waypoint), C.byref(mutable))
        if reason is None:
            raise self.library.error()
        return {"available": True, "reason": reason.decode("ascii"),
                "waypoint_index": waypoint.value, "landing_yaw_mutable": bool(mutable.value)}

    def traffic(self, right_m=0.0, speed_factor=1.0):
        if not self.handle:
            raise RuntimeError('pilot is closed')
        if not math.isfinite(right_m) or not 0 <= right_m <= 80 or not math.isfinite(speed_factor) or not .75 <= speed_factor <= 1:
            raise ValueError('invalid traffic intent')
        if not self.library.traffic_capable:
            if right_m or speed_factor != 1:
                raise RuntimeError('교통 회피 적용을 위해 native pilot 재빌드가 필요합니다')
            return
        if self.library.lib.aerodt_pilot_traffic(self.handle, right_m, speed_factor):
            raise self.library.error()

    def advance(self, seconds, hold=None):
        if not self.handle:
            raise RuntimeError("pilot is closed")
        if not math.isfinite(seconds) or not 0 <= seconds <= 2:
            raise ValueError("native step outside 0..2 seconds")
        if hold is not None and (len(hold) != 3 or not all(math.isfinite(x) for x in hold)):
            raise ValueError("invalid hold position")
        target = None if hold is None else (C.c_double * 3)(*hold)
        if self.library.lib.aerodt_pilot_step(self.handle, seconds, target, self.output):
            raise self.library.error()
        return tuple(self.output)

    def close(self):
        if getattr(self, "handle", None):
            self.library.lib.aerodt_pilot_destroy(self.handle)
            self.handle = None

    def __del__(self):
        self.close()
