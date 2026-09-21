#pragma once

#include <array>
#include <chrono>

#include "aerodt/digital_twin/contracts/vehicle_state.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/pid_controller.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_goal.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_parameters.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_mixer.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {

struct TiltrotorFixedWingOutput {
  ControlAxes controls;
  double desired_pitch_rad{};
  double desired_yaw_rate_body_radps{};
  double desired_speed_mps{};
  double measured_speed_mps{};
};

// Native equivalent of the velocity-command path through ProjectAirSim's
// TRController. Horizontal velocity is used by the speed/throttle controller,
// vertical NED velocity sets pitch, and an explicit heading or yaw-rate goal
// owns the yaw channel. Roll is held at zero for this command shape.
class TiltrotorFixedWingController final {
 public:
  explicit TiltrotorFixedWingController(SimpleFlightParameters parameters);

  void Reset();
  [[nodiscard]] TiltrotorFixedWingOutput Update(
      const VelocityYawRateGoalNed& goal,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);
  [[nodiscard]] TiltrotorFixedWingOutput Update(
      const VelocityYawAngleGoalNed& goal,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);

 private:
  enum class YawGoalMode { unknown, angle, rate };

  [[nodiscard]] TiltrotorFixedWingOutput UpdateVelocity(
      const foundation::math::Vector3& velocity_ned_mps,
      YawGoalMode yaw_mode, double yaw_value,
      const contracts::VehicleState& state,
      std::chrono::nanoseconds step);
  [[nodiscard]] double UpdateAngleLevelAxis(
      std::size_t axis, double goal_angle_rad, double measured_angle_rad,
      double measured_rate_radps, double step_seconds,
      TiltrotorFixedWingOutput& output);
  void PrepareYawMode(YawGoalMode mode);

  SimpleFlightParameters parameters_;
  std::array<PidController, kControlAxisCount> angle_level_pid_;
  std::array<PidController, kControlAxisCount> angle_rate_pid_;
  PidController vertical_velocity_pid_;
  PidController speed_pid_;
  YawGoalMode yaw_goal_mode_{YawGoalMode::unknown};
};

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
