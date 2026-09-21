#pragma once

#include "aerodt/foundation/math/vector3.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

// Goal types keep the coordinate frame and angular unit in the type name or
// member name. Separate yaw-angle and yaw-rate types prevent a caller from
// silently interpreting radians as radians per second.
struct PositionYawRateGoalNed {
  foundation::math::Vector3 position_ned_m{};
  double yaw_rate_body_radps{};
};

struct VelocityYawRateGoalNed {
  foundation::math::Vector3 velocity_ned_mps{};
  double yaw_rate_body_radps{};
};

struct VelocityYawAngleGoalNed {
  foundation::math::Vector3 velocity_ned_mps{};
  double yaw_angle_ned_rad{};
  // Permission, not a requested angle or a flight-mode change. The vehicle
  // package and controller bound the assistance; precision hover opts out.
  bool allow_rotor_tilt_assist{false};
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
