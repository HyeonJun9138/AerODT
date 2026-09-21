#pragma once

#include <chrono>

#include "aerodt/digital_twin/contracts/wrench.hpp"
#include "aerodt/foundation/math/quaternion.hpp"

namespace aerodt::digital_twin::simulation::actuation {

enum class RotorTurningDirection : int { counter_clockwise = -1, clockwise = 1 };

struct RotorParameters {
  foundation::math::Vector3 position_body_m{};
  foundation::math::Vector3 normal_rotor{0.0, 0.0, -1.0};
  RotorTurningDirection turning_direction{RotorTurningDirection::clockwise};
  double coefficient_of_thrust{};
  double coefficient_of_torque{};
  double max_rpm{};
  double propeller_diameter_m{};
  double smoothing_time_constant_s{};
};

struct RotorOutput {
  double filtered_control{};
  double rotating_speed_radps{};
  double thrust_n{};
  double reaction_torque_nm{};
  double power_w{};
  double angle_rad{};
  foundation::math::Vector3 position_body_m{};
  foundation::math::Vector3 force_body_n{};
  foundation::math::Vector3 torque_body_nm{};
};

class RotorActuator final {
 public:
  explicit RotorActuator(RotorParameters parameters);

  void Reset();
  void SetTilt(const foundation::math::Quaternion& body_rotation_from_rotor);
  void SetAirDensityRatio(double ratio);
  void SetFaulted(bool faulted) noexcept;
  [[nodiscard]] RotorOutput Update(double control, std::chrono::nanoseconds step);

  [[nodiscard]] double MaxThrustN() const noexcept;
  [[nodiscard]] double MaxTorqueNm() const noexcept;

 private:
  RotorParameters parameters_;
  foundation::math::Quaternion tilt_rotation_{};
  double air_density_ratio_{1.0};
  double filtered_control_{};
  double angle_rad_{};
  double max_speed_squared_{};
  double max_thrust_n_{};
  double max_torque_nm_{};
  bool faulted_{};
};

[[nodiscard]] contracts::Wrench AggregateRotorWrench(
    const RotorOutput* outputs, std::size_t count,
    const foundation::math::Quaternion& body_to_ned);

}  // namespace aerodt::digital_twin::simulation::actuation
