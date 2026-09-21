#include "aerodt/digital_twin/simulation/control/simple_flight/ground_truth_state_estimator.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::control::simple_flight {

GroundTruthStateEstimator::GroundTruthStateEstimator(
    const contracts::VehicleState& state)
    : state_(state) {
  if (!state_.position_ned_m.IsFinite() ||
      !state_.linear_velocity_ned_mps.IsFinite() ||
      !state_.angular_velocity_body_radps.IsFinite() ||
      !state_.orientation_body_to_ned.IsFinite()) {
    throw std::invalid_argument("SimpleFlight ground-truth state must be finite.");
  }
  static_cast<void>(state_.orientation_body_to_ned.Normalized());
}

const foundation::math::Vector3& GroundTruthStateEstimator::PositionNed() const noexcept {
  return state_.position_ned_m;
}

const foundation::math::Vector3&
GroundTruthStateEstimator::LinearVelocityNed() const noexcept {
  return state_.linear_velocity_ned_mps;
}

const foundation::math::Vector3&
GroundTruthStateEstimator::AngularVelocityBody() const noexcept {
  return state_.angular_velocity_body_radps;
}

foundation::math::Vector3 GroundTruthStateEstimator::RollPitchYawRad() const {
  const auto quaternion = state_.orientation_body_to_ned.Normalized();
  const double y_squared = quaternion.y * quaternion.y;
  const double roll = std::atan2(
      2.0 * (quaternion.w * quaternion.x + quaternion.y * quaternion.z),
      1.0 - 2.0 * (quaternion.x * quaternion.x + y_squared));
  const double pitch_argument = std::clamp(
      2.0 * (quaternion.w * quaternion.y - quaternion.z * quaternion.x),
      -1.0, 1.0);
  const double pitch = std::asin(pitch_argument);
  const double yaw = std::atan2(
      2.0 * (quaternion.w * quaternion.z + quaternion.x * quaternion.y),
      1.0 - 2.0 * (y_squared + quaternion.z * quaternion.z));
  return {roll, pitch, yaw};
}

foundation::math::Vector3 GroundTruthStateEstimator::TransformNedToBody(
    const foundation::math::Vector3& value_ned) const {
  if (!value_ned.IsFinite()) {
    throw std::invalid_argument("SimpleFlight vector transform input must be finite.");
  }
  return state_.orientation_body_to_ned.Normalized().Conjugate().Rotate(value_ned);
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
