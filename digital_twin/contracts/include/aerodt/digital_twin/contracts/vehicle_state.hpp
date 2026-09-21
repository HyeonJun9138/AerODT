#pragma once

#include "aerodt/foundation/math/quaternion.hpp"
#include "aerodt/foundation/math/vector3.hpp"
#include "aerodt/foundation/time/simulation_time.hpp"

namespace aerodt::digital_twin::contracts {

struct VehicleState {
  foundation::time::SimulationTime time;
  foundation::math::Vector3 position_ned_m{};
  foundation::math::Quaternion orientation_body_to_ned{};
  foundation::math::Vector3 linear_velocity_ned_mps{};
  foundation::math::Vector3 angular_velocity_body_radps{};
  foundation::math::Vector3 linear_acceleration_ned_mps2{};
  foundation::math::Vector3 angular_acceleration_body_radps2{};
};

}  // namespace aerodt::digital_twin::contracts
