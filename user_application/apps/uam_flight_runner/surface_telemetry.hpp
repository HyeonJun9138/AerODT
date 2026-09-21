#pragma once
#include <algorithm>
#include <array>
#include "aerodt/digital_twin/runtime/uam_vehicle_runtime.hpp"

// Read-only display telemetry. The first three channels are measured actuator
// angles. AirTaxi has no rudder actuator: channel four is a visibly disclosed
// yaw-command indication for substitute V-tail/rudder rigs, not a physical angle.
struct SurfaceTelemetry {
  std::array<double, 4> degrees{};
  bool valid{};
  void Capture(const aerodt::digital_twin::runtime::UamTickResult& tick) {
    int found=0;
    for (const auto& surface : tick.control_surfaces) {
      int channel=surface.id=="Wing_L_Aileron_actuator" ? 0 :
                  surface.id=="Wing_R_Aileron_actuator" ? 1 :
                  surface.id=="Elevator_actuator" ? 2 : -1;
      if(channel>=0){degrees[channel]=surface.value.angle_rad*180.0/3.141592653589793; ++found;}
    }
    const auto& c=tick.controller_output;
    degrees[3]=20.0*std::clamp(c.yaw,-1.0,1.0)*std::clamp(c.allocation_blend.value_or(c.tilt),0.0,1.0);
    valid=found==3;
  }
};
