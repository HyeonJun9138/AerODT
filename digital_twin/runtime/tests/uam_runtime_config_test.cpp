#include <cmath>
#include <iostream>
#include <stdexcept>

#include "aerodt/digital_twin/runtime/uam_runtime_config.hpp"

namespace {

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("UAM model package compilation assertion failed.");
  }
}

}  // namespace

int main() {
  const auto config = aerodt::digital_twin::runtime::LoadAeroDTAirTaxiRuntimeConfig();
  if (config.package_id != "aerodt.vehicle.air.tiltrotor_uam.airtaxi" ||
      config.package_version != "0.2.2" ||
      config.entity_id != "UAM1" ||
      config.physics_id != "fast-physics" || config.controller_id != "simple-flight" ||
      config.airframe_id != "vtol-quad-tiltrotor") {
    throw std::runtime_error("UAM manifest was not compiled correctly.");
  }
  if (config.step.count() != 3000000 || config.rotors.size() != 4 ||
      config.tilts.size() != 4 || config.lifting_surfaces.size() != 3 ||
      config.fast_physics.drag_faces.size() != 6 || config.actuator_order.size() != 11 ||
      config.sensors.imu.size() != 1 || config.sensors.gps.size() != 1 ||
      config.sensors.cameras.size() != 2) {
    throw std::runtime_error("UAM runtime topology differs from the model package.");
  }
  Near(config.fast_physics.mass_kg, 10.0, 1e-12, "AirTaxi mass");
  Near(config.initial_position_ned_m.z, -4.0, 1e-12, "AirTaxi initial z");
  Near(config.body_ground_clearance_m, 1.34, 1e-12,
       "AirTaxi body ground clearance");
  Near(config.rotors[0].parameters.coefficient_of_thrust, 0.109919, 1e-12,
       "AirTaxi rotor Ct");
  Near(config.tilts[0].parameters.angle_max_rad, 1.57, 1e-12, "AirTaxi tilt maximum");
  Near(config.lifting_surfaces[0].surface.parameters.area_m2, 5.0, 1e-12,
       "AirTaxi left-wing area");
  Near(config.lifting_surfaces[0].control_parameters.rotation_rate_rad_per_unit,
       0.524, 1e-12, "AirTaxi aileron rotation rate");
  Near(config.simple_flight.fixed_wing_stall_speed_mps, 2.0, 1e-12,
       "AirTaxi transition stall speed");
  Near(config.simple_flight.multirotor.angle_rate.maximum[0], 0.3, 1e-12,
       "AirTaxi multirotor roll-rate maximum");
  Near(config.simple_flight.multirotor.minimum_throttle, 0.001, 1e-12,
       "AirTaxi multirotor minimum throttle");
  Near(config.sensors.home_latitude_deg, 37.5665, 1e-12,
       "AirTaxi home latitude");
  if (!config.sensors.gps[0].enabled ||
      config.sensors.cameras[1].id != "DownCamera" ||
      config.sensors.cameras[1].enabled_image_types.size() != 2) {
    throw std::runtime_error("Native sensor package was not compiled correctly.");
  }
  if (!config.simple_flight.fixed_wing_capable) {
    throw std::runtime_error("AirTaxi fixed-wing capability was not compiled.");
  }
  if (config.tilts[0].target_rotor_id != "Prop_FL_actuator" ||
      config.lifting_surfaces[0].control_actuator_id != "Wing_L_Aileron_actuator" ||
      config.actuator_order[10] != "Elevator_actuator") {
    throw std::runtime_error("UAM actuator references were not preserved.");
  }
  std::cout << "AERODT_UAM_CONFIG_COMPILER=PASS\n";
  return 0;
}
