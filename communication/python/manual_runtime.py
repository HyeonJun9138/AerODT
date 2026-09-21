"""Manual input C ABI v3. Runtime handle owns all flight state."""
import ctypes as C
from pathlib import Path

from digital_twin.contracts.pilot_vehicle import PilotVehicleCommand

class ManualRuntime:
    def __init__(self, yaw=0):
        root=Path(__file__).resolve().parents[2]
        path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v12.dll'
        if not path.is_file():
            path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v11.dll'
        if not path.is_file():
            path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v10.dll'
        if not path.is_file():
            path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v9.dll'
        if not path.is_file():
            path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v8.dll'
        if not path.is_file():
            path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v7.dll'
        if not path.is_file():
            path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v6.dll'
        if not path.is_file():
            path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v5.dll'
        if not path.is_file():
            path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v4.dll'
        if not path.is_file():
            path=root/'project_support/build/aerodt/windows-release/bin/aerodt_uam_manual_v3.dll'
        if not path.is_file():
            path=next((root/'project_support/build/aerodt/linux-release/bin'/name for name in ('libaerodt_uam_manual_v12.so','libaerodt_uam_manual_v11.so','libaerodt_uam_manual_v10.so','libaerodt_uam_manual_v9.so','libaerodt_uam_manual_v8.so','libaerodt_uam_manual_v7.so','libaerodt_uam_manual_v6.so','libaerodt_uam_manual_v5.so','libaerodt_uam_manual_v4.so','libaerodt_uam_manual_v3.so') if (root/'project_support/build/aerodt/linux-release/bin'/name).is_file()),path)
        self.lib=C.CDLL(str(path));lib=self.lib
        lib.aerodt_manual_error.restype=C.c_char_p
        lib.aerodt_manual_create.argtypes=[C.c_double];lib.aerodt_manual_create.restype=C.c_void_p
        lib.aerodt_manual_step_v2.argtypes=[C.c_void_p,C.POINTER(C.c_double),C.c_int,C.POINTER(C.c_double)];lib.aerodt_manual_step_v2.restype=C.c_int
        lib.aerodt_manual_destroy.argtypes=[C.c_void_p];lib.aerodt_manual_destroy.restype=None
        lib.aerodt_manual_surface.argtypes=[C.c_void_p,C.c_double];lib.aerodt_manual_surface.restype=C.c_int
        lib.aerodt_manual_deck.argtypes=[C.c_void_p,C.POINTER(C.c_double),C.c_int,C.c_double];lib.aerodt_manual_deck.restype=C.c_int
        self.guidance_writer=getattr(lib,'aerodt_manual_guidance',None)
        if self.guidance_writer:
            self.guidance_writer.argtypes=[C.c_void_p,C.c_int,C.c_double,C.c_double,C.c_double];self.guidance_writer.restype=C.c_int
        self.collective_reader=getattr(lib,'aerodt_manual_collective',None)
        if self.collective_reader:
            self.collective_reader.argtypes=[C.c_void_p];self.collective_reader.restype=C.c_double
        self.surface_reader=getattr(lib,'aerodt_manual_control_surfaces',None)
        if self.surface_reader:
            self.surface_reader.argtypes=[C.c_void_p,C.POINTER(C.c_double),C.c_int];self.surface_reader.restype=C.c_int
        self.handle=lib.aerodt_manual_create(yaw)
        if not self.handle:raise RuntimeError(lib.aerodt_manual_error().decode())
    def step(self, throttle=0,roll=0,pitch=0,wing=False,steps=12,yaw=0):
        out=(C.c_double*13)();values=(C.c_double*5)(throttle,roll,pitch,float(wing),yaw)
        if not self.handle or not self.lib.aerodt_manual_step_v2(self.handle,values,steps,out):
            raise RuntimeError(self.lib.aerodt_manual_error().decode())
        return list(out)
    def apply_pilot_command(self, command, steps=12):
        """Translate one typed Pilot command at the Runtime technology edge."""
        if not isinstance(command, PilotVehicleCommand):
            raise TypeError('PilotVehicleCommand required')
        goal=command.guidance
        self.guidance(goal is not None,
                      goal.heading_deg if goal else 0,
                      goal.down_m if goal else 0,
                      goal.speed_mps if goal else 0)
        return self.step(command.throttle,command.roll,command.pitch,
                         command.flight_mode=='fixed_wing',steps,yaw=command.yaw)
    def guidance(self, enabled, heading=0, down=0, speed=0):
        if not self.guidance_writer:
            if enabled:raise RuntimeError('AP native library rebuild required')
            return
        if not self.guidance_writer(self.handle,int(enabled),heading,down,speed):raise ValueError(self.lib.aerodt_manual_error().decode())
    def collective(self):
        return self.collective_reader(self.handle) if self.collective_reader else None
    def control_surfaces(self):
        out=(C.c_double*4)()
        return tuple(out) if self.handle and self.surface_reader and self.surface_reader(self.handle,out,4) else None
    def surface(self,down):
        if not self.lib.aerodt_manual_surface(self.handle,down):raise ValueError(self.lib.aerodt_manual_error().decode())
    def deck(self,points,down):
        data=(C.c_double*(2*len(points)))(*(v for p in points for v in p))
        if not self.lib.aerodt_manual_deck(self.handle,data,len(points),down):raise ValueError(self.lib.aerodt_manual_error().decode())
    def close(self):
        if self.handle:self.lib.aerodt_manual_destroy(self.handle);self.handle=None
