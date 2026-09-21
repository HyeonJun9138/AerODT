#pragma once

#include "aerodt/foundation/math/vector3.hpp"

namespace aerodt::digital_twin::contracts {

// Immutable observation supplied by a visualization or geometry adapter.
// FastPhysics remains authoritative for the resulting vehicle state.
struct ContactObservation {
  bool has_collided{};
  foundation::math::Vector3 normal_ned{};
  foundation::math::Vector3 collision_position_ned_m{};
  // Matches ProjectAirSim CollisionInfo's convention for parity.
  foundation::math::Vector3 impact_point_ned_m{};
  double penetration_depth_m{};
};

}  // namespace aerodt::digital_twin::contracts
