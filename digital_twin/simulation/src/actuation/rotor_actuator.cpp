#include "aerodt/digital_twin/simulation/actuation/rotor_actuator.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::actuation {
namespace {

constexpr double kBaseAirDensityKgM3 = 1.225;

double Filter(double input, double previous, double time_constant, double dt) {
  if (time_constant == 0.0) return input;
  const double alpha = std::exp(-dt / time_constant);
  return previous * alpha + input * (1.0 - alpha);
}

}  // namespace

RotorActuator::RotorActuator(RotorParameters parameters) : parameters_(parameters) {
  const double normal_norm = parameters_.normal_rotor.Norm();
  if (normal_norm <= 1e-12 || !parameters_.normal_rotor.IsFinite()) {
    throw std::invalid_argument("Rotor normal must be finite and non-zero.");
  }
  if (parameters_.coefficient_of_thrust < 0.0 ||
      parameters_.coefficient_of_torque < 0.0 || parameters_.max_rpm < 0.0 ||
      parameters_.propeller_diameter_m < 0.0 ||
      parameters_.smoothing_time_constant_s < 0.0) {
    throw std::invalid_argument("Rotor parameters cannot be negative.");
  }
  parameters_.normal_rotor = parameters_.normal_rotor / normal_norm;
  const double revolutions_per_second = parameters_.max_rpm / 60.0;
  const double angular_speed = revolutions_per_second * 2.0 * std::numbers::pi;
  max_speed_squared_ = angular_speed * angular_speed;
  max_thrust_n_ = parameters_.coefficient_of_thrust * kBaseAirDensityKgM3 *
                  revolutions_per_second * revolutions_per_second *
                  std::pow(parameters_.propeller_diameter_m, 4);
  max_torque_nm_ = parameters_.coefficient_of_torque * kBaseAirDensityKgM3 *
                   revolutions_per_second * revolutions_per_second *
                   std::pow(parameters_.propeller_diameter_m, 5) /
                   (2.0 * std::numbers::pi);
}

void RotorActuator::Reset() {
  filtered_control_ = 0.0;
  angle_rad_ = 0.0;
  faulted_ = false;
  tilt_rotation_ = {};
  air_density_ratio_ = 1.0;
}

void RotorActuator::SetTilt(
    const foundation::math::Quaternion& body_rotation_from_rotor) {
  tilt_rotation_ = body_rotation_from_rotor.Normalized();
}

void RotorActuator::SetAirDensityRatio(double ratio) {
  if (!std::isfinite(ratio) || ratio < 0.0) {
    throw std::invalid_argument("Rotor air density ratio is invalid.");
  }
  air_density_ratio_ = ratio;
}

void RotorActuator::SetFaulted(bool faulted) noexcept { faulted_ = faulted; }

RotorOutput RotorActuator::Update(double control, std::chrono::nanoseconds step) {
  const double dt = std::chrono::duration<double>(step).count();
  if (!std::isfinite(control) || dt <= 0.0) {
    throw std::invalid_argument("Rotor update input is invalid.");
  }
  const double clamped = std::clamp(control, 0.0, 1.0);
  filtered_control_ = Filter(
      clamped, filtered_control_, parameters_.smoothing_time_constant_s, dt);

  double rotating_speed = std::sqrt(filtered_control_ * max_speed_squared_);
  double thrust = filtered_control_ * max_thrust_n_;
  double torque = filtered_control_ * max_torque_nm_ *
                  static_cast<int>(parameters_.turning_direction);
  if (faulted_) {
    rotating_speed = 0.0;
    thrust = 0.0;
    torque = 0.0;
  }
  const double power = std::abs(torque * rotating_speed);
  const auto force_rotor = parameters_.normal_rotor * thrust * air_density_ratio_;
  const auto torque_rotor = parameters_.normal_rotor * torque * air_density_ratio_;
  const auto force_body = tilt_rotation_.Rotate(force_rotor);
  const auto torque_body = tilt_rotation_.Rotate(torque_rotor);

  angle_rad_ += rotating_speed * dt * static_cast<int>(parameters_.turning_direction);
  angle_rad_ = std::fmod(angle_rad_, 2.0 * std::numbers::pi);
  if (angle_rad_ < 0.0) angle_rad_ += 2.0 * std::numbers::pi;

  return {
      .filtered_control = filtered_control_,
      .rotating_speed_radps = rotating_speed,
      .thrust_n = thrust,
      .reaction_torque_nm = torque,
      .power_w = power,
      .angle_rad = angle_rad_,
      .position_body_m = parameters_.position_body_m,
      .force_body_n = force_body,
      .torque_body_nm = torque_body,
  };
}

double RotorActuator::MaxThrustN() const noexcept { return max_thrust_n_; }
double RotorActuator::MaxTorqueNm() const noexcept { return max_torque_nm_; }

contracts::Wrench AggregateRotorWrench(
    const RotorOutput* outputs, std::size_t count,
    const foundation::math::Quaternion& body_to_ned) {
  foundation::math::Vector3 force_body{};
  foundation::math::Vector3 torque_body{};
  for (std::size_t index = 0; index < count; ++index) {
    const auto& output = outputs[index];
    force_body = force_body + output.force_body_n;
    torque_body = torque_body + output.torque_body_nm +
                  output.position_body_m.Cross(output.force_body_n);
  }
  return {
      .force_ned_n = body_to_ned.Rotate(force_body),
      .torque_body_nm = torque_body,
  };
}

}  // namespace aerodt::digital_twin::simulation::actuation
