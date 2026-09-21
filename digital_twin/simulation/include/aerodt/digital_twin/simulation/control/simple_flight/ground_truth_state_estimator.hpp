#pragma once

#include "aerodt/digital_twin/contracts/vehicle_state.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

// V1 deliberately mirrors AirSimSimpleFlightEstimator: no sensor fusion is
// performed and the controller receives a deterministic view of ground truth.
// Keeping this conversion here prevents controller code from owning runtime
// state or depending on Unreal types.
class GroundTruthStateEstimator final {
 public:
  explicit GroundTruthStateEstimator(const contracts::VehicleState& state);

  [[nodiscard]] const foundation::math::Vector3& PositionNed() const noexcept;
  [[nodiscard]] const foundation::math::Vector3& LinearVelocityNed() const noexcept;
  [[nodiscard]] const foundation::math::Vector3& AngularVelocityBody() const noexcept;
  [[nodiscard]] foundation::math::Vector3 RollPitchYawRad() const;
  [[nodiscard]] foundation::math::Vector3 TransformNedToBody(
      const foundation::math::Vector3& value_ned) const;

 private:
  const contracts::VehicleState& state_;
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
