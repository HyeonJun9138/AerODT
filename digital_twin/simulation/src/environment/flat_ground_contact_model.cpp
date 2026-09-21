#include "aerodt/digital_twin/simulation/environment/flat_ground_contact_model.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::environment {

FlatGroundContactModel::FlatGroundContactModel(FlatGroundParameters parameters)
    : parameters_(parameters) {
  if (!std::isfinite(parameters_.ground_plane_down_m) ||
      !std::isfinite(parameters_.body_ground_clearance_m) ||
      parameters_.body_ground_clearance_m <= 0.0) {
    throw std::invalid_argument(
        "Flat-ground parameters must be finite and clearance must be positive.");
  }
}

contracts::ContactObservation FlatGroundContactModel::Observe(
    const contracts::VehicleState& state) const {
  if (!state.position_ned_m.IsFinite() ||
      !state.linear_velocity_ned_mps.IsFinite()) {
    throw std::invalid_argument("Flat-ground state must be finite.");
  }

  const double lowest_point_down_m =
      state.position_ned_m.z + parameters_.body_ground_clearance_m;
  if (lowest_point_down_m < parameters_.ground_plane_down_m) {
    return {};
  }

  return {
      .has_collided = true,
      .normal_ned = {0.0, 0.0, -1.0},
      .collision_position_ned_m = state.position_ned_m,
      .impact_point_ned_m = {
          state.position_ned_m.x,
          state.position_ned_m.y,
          parameters_.ground_plane_down_m,
      },
      .penetration_depth_m = std::max(
          0.0, lowest_point_down_m - parameters_.ground_plane_down_m),
  };
}

}  // namespace aerodt::digital_twin::simulation::environment
