#pragma once

#include <array>
#include <chrono>

#include "aerodt/digital_twin/contracts/vehicle_state.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/pid_controller.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_goal.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_parameters.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_mixer.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

struct MultirotorCascadeOutput {
  ControlAxes controls;
  foundation::math::Vector3 desired_velocity_ned_mps{};
  foundation::math::Vector3 desired_roll_pitch_yaw_rad{};
  foundation::math::Vector3 desired_angular_velocity_body_radps{};
};

// Native, V1-focused equivalent of SimpleFlight's per-axis
// Position -> Velocity -> AngleLevel -> AngleRate cascade. It intentionally
// accepts explicit typed UAM goals instead of carrying the legacy run-time
// GoalMode class graph into AeroDT.
class MultirotorCascadeController final {
 public:
  explicit MultirotorCascadeController(CascadeParameters parameters);

  void Reset();
  // Keep proportional/derivative continuity while this controller is inactive.
  void ClearHorizontalVelocityIntegral() noexcept;
  [[nodiscard]] MultirotorCascadeOutput Update(
      const PositionYawRateGoalNed& goal,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);
  [[nodiscard]] MultirotorCascadeOutput Update(
      const VelocityYawRateGoalNed& goal,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);
  [[nodiscard]] MultirotorCascadeOutput Update(
      const VelocityYawAngleGoalNed& goal,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);

 private:
  enum class TranslationGoalMode { unknown, position, velocity };
  enum class YawGoalMode { unknown, angle, rate };

  [[nodiscard]] MultirotorCascadeOutput UpdateVelocity(
      const foundation::math::Vector3& velocity_ned_mps,
      YawGoalMode yaw_mode, double yaw_value,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);
  [[nodiscard]] double UpdateAngleLevelAxis(
      std::size_t axis, double goal_angle_rad, double measured_angle_rad,
      double measured_rate_radps, double step_seconds,
      MultirotorCascadeOutput& output);
  void PrepareGoalModes(TranslationGoalMode translation_mode,
                        YawGoalMode yaw_mode);
  void ResetTranslationControllers();
  void ResetYawControllers();

  CascadeParameters parameters_;
  std::array<PidController, kControlAxisCount> position_pid_;
  std::array<PidController, kControlAxisCount> velocity_pid_;
  std::array<PidController, kControlAxisCount> angle_level_pid_;
  std::array<PidController, kControlAxisCount> angle_rate_pid_;
  TranslationGoalMode translation_goal_mode_{TranslationGoalMode::unknown};
  YawGoalMode yaw_goal_mode_{YawGoalMode::unknown};
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
