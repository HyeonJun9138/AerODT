#pragma once

#include <chrono>

#include "aerodt/digital_twin/contracts/contact_observation.hpp"
#include "aerodt/digital_twin/contracts/vehicle_state.hpp"
#include "aerodt/digital_twin/contracts/wrench.hpp"
#include "aerodt/foundation/math/matrix3.hpp"

namespace aerodt::digital_twin::simulation::contact {

struct ContactParameters {
  double restitution{};
  double friction{};
  double landing_axis_tolerance{0.01};
  double collision_offset_m{0.001};
};

[[nodiscard]] bool ShouldRemainGrounded(
    bool currently_grounded, const contracts::VehicleState& state,
    const contracts::Wrench& external_wrench,
    const foundation::math::Vector3& gravity_ned_mps2, double mass_kg);

[[nodiscard]] bool NeedsCollisionResponse(
    const contracts::ContactObservation& contact,
    const contracts::VehicleState& candidate_state);

[[nodiscard]] bool IsLandingCollision(
    const contracts::ContactObservation& contact,
    const contracts::VehicleState& current_state,
    double axis_tolerance = 0.01);

[[nodiscard]] contracts::VehicleState CalculateGroundedState(
    const contracts::VehicleState& current_state,
    const foundation::math::Vector3& grounded_position_ned_m);

[[nodiscard]] contracts::VehicleState CalculateCollisionResponse(
    std::chrono::nanoseconds step, const contracts::VehicleState& current_state,
    const contracts::ContactObservation& contact,
    double mass_kg,
    const foundation::math::Matrix3& inertia_body_kg_m2,
    const ContactParameters& parameters);

}  // namespace aerodt::digital_twin::simulation::contact
