#pragma once

#include <cstddef>
#include <vector>

#include "aerodt/digital_twin/contracts/contact_observation.hpp"
#include "aerodt/digital_twin/simulation/contact/contact_response.hpp"
#include "aerodt/digital_twin/simulation/aerodynamics/aerodynamic_model.hpp"
#include "aerodt/foundation/math/matrix3.hpp"

namespace aerodt::digital_twin::simulation::fast_physics {

struct FastPhysicsParameters {
  double mass_kg{1.0};
  foundation::math::Matrix3 inertia_body_kg_m2{foundation::math::Matrix3::Identity()};
  foundation::math::Vector3 gravity_ned_mps2{0.0, 0.0, 9.80665};
  double speed_limit_mps{299792458.0};
  aerodynamics::AerodynamicEnvironment aerodynamic_environment{};
  std::vector<aerodynamics::DragFace> drag_faces{};
  std::vector<aerodynamics::LiftingSurface> lifting_surfaces{};
};

class FastPhysicsEngine final {
 public:
  explicit FastPhysicsEngine(FastPhysicsParameters parameters);

  void Reset(const contracts::VehicleState& state);
  const contracts::VehicleState& Advance(
      std::chrono::nanoseconds step, const contracts::Wrench& previous_step_wrench);
  const contracts::VehicleState& Advance(
      std::chrono::nanoseconds step,
      const contracts::Wrench& previous_step_wrench,
      const contracts::ContactObservation& contact_observation,
      const contact::ContactParameters& contact_parameters);
  // Explicit training-only ground assist; not a wheel or collision model.
  const contracts::VehicleState& AdvanceGroundAssist(std::chrono::nanoseconds step,
      double forward_mps, double right_mps, double yaw_rate_radps, double body_down_m);
  [[nodiscard]] const contracts::VehicleState& State() const noexcept;
  [[nodiscard]] bool IsGrounded() const noexcept;

  void SetAerodynamicEnvironment(const aerodynamics::AerodynamicEnvironment& environment);
  void SetControlSurfaceAngle(std::size_t surface_index, double angle_rad);

 private:
  [[nodiscard]] contracts::VehicleState CalculateFreeFlightNext(
      std::chrono::nanoseconds step,
      const contracts::Wrench& previous_step_wrench) const;
  [[nodiscard]] contracts::VehicleState CalculateGroundedNext(
      std::chrono::nanoseconds step,
      const foundation::math::Vector3& position_ned_m) const;

  FastPhysicsParameters parameters_;
  foundation::math::Matrix3 inverse_inertia_;
  contracts::VehicleState state_{};
  bool is_grounded_{};
};

}  // namespace aerodt::digital_twin::simulation::fast_physics
