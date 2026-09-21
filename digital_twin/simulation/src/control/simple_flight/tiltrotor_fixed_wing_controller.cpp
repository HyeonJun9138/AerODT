#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_fixed_wing_controller.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

#include "aerodt/digital_twin/simulation/control/simple_flight/ground_truth_state_estimator.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;

std::array<PidController, kControlAxisCount> MakeControllers(
    const AxisPidGroup& group) {
  return {
      PidController(group.pid[0]), PidController(group.pid[1]),
      PidController(group.pid[2]), PidController(group.pid[3]),
  };
}

PidController MakeVerticalVelocityController(
    const SimpleFlightParameters& parameters) {
  auto pid = parameters.fixed_wing.velocity.pid[kThrottleAxis];
  // VelocityControllerTRZH constructs PidConfig from P/I/D only, unlike the
  // independent throttle controller which also loads discount and bias.
  pid.integral_discount = 1.0;
  pid.output_bias = 0.0;
  return PidController(pid);
}

void AdjustToMinimumDistance(double& measured, double& goal) {
  measured = std::fmod(measured, kTwoPi);
  goal = std::fmod(goal, kTwoPi);
  if (measured < 0.0) measured += kTwoPi;
  if (goal < 0.0) goal += kTwoPi;
  const double distance = measured - goal;
  if (distance > kPi) {
    measured -= kTwoPi;
  } else if (distance < -kPi) {
    goal -= kTwoPi;
  }
}

void ValidateGoal(const foundation::math::Vector3& velocity_ned_mps,
                  double yaw_value, std::chrono::nanoseconds step) {
  if (!velocity_ned_mps.IsFinite() || !std::isfinite(yaw_value) ||
      step.count() <= 0) {
    throw std::invalid_argument(
        "SimpleFlight fixed-wing velocity goal must be finite and step must be positive.");
  }
}

}  // namespace

TiltrotorFixedWingController::TiltrotorFixedWingController(
    SimpleFlightParameters parameters)
    : parameters_(std::move(parameters)),
      angle_level_pid_(MakeControllers(parameters_.fixed_wing.angle_level)),
      angle_rate_pid_(MakeControllers(parameters_.fixed_wing.angle_rate)),
      vertical_velocity_pid_(MakeVerticalVelocityController(parameters_)),
      speed_pid_(parameters_.fixed_wing.velocity.pid[kThrottleAxis]) {
  if (!std::isfinite(parameters_.fixed_wing_minimum_pitch_rad) ||
      parameters_.fixed_wing_minimum_pitch_rad < 0.0 ||
      parameters_.fixed_wing_minimum_pitch_rad > kPi / 2.0) {
    throw std::invalid_argument(
        "SimpleFlight fixed-wing minimum pitch must be in [0, pi/2].");
  }
  Reset();
}

void TiltrotorFixedWingController::Reset() {
  for (std::size_t axis = 0; axis < kControlAxisCount; ++axis) {
    angle_level_pid_[axis].Reset();
    angle_rate_pid_[axis].Reset();
  }
  vertical_velocity_pid_.Reset();
  speed_pid_.Reset();
  yaw_goal_mode_ = YawGoalMode::unknown;
}

TiltrotorFixedWingOutput TiltrotorFixedWingController::Update(
    const VelocityYawRateGoalNed& goal,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  ValidateGoal(goal.velocity_ned_mps, goal.yaw_rate_body_radps, step);
  return UpdateVelocity(goal.velocity_ned_mps, YawGoalMode::rate,
                        goal.yaw_rate_body_radps, state, step);
}

TiltrotorFixedWingOutput TiltrotorFixedWingController::Update(
    const VelocityYawAngleGoalNed& goal,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  ValidateGoal(goal.velocity_ned_mps, goal.yaw_angle_ned_rad, step);
  return UpdateVelocity(goal.velocity_ned_mps, YawGoalMode::angle,
                        goal.yaw_angle_ned_rad, state, step);
}

TiltrotorFixedWingOutput TiltrotorFixedWingController::UpdateVelocity(
    const foundation::math::Vector3& velocity_ned_mps,
    YawGoalMode yaw_mode, double yaw_value,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  PrepareYawMode(yaw_mode);
  const double step_seconds = std::chrono::duration<double>(step).count();
  const GroundTruthStateEstimator estimate(state);
  const auto measured_angles = estimate.RollPitchYawRad();
  const auto measured_rate = estimate.AngularVelocityBody();
  const auto measured_velocity = estimate.LinearVelocityNed();

  TiltrotorFixedWingOutput output;

  // TRXTorqueController falls back to a zero roll angle when X/Y are world
  // velocity goals.
  output.controls.roll = UpdateAngleLevelAxis(
      kRollAxis, 0.0, measured_angles.x, measured_rate.x, step_seconds,
      output);

  const double vertical_output = vertical_velocity_pid_.Update(
      velocity_ned_mps.z, measured_velocity.z, step_seconds);
  output.desired_pitch_rad =
      -vertical_output * parameters_.fixed_wing.angle_level.maximum[kPitchAxis];
  output.controls.pitch = UpdateAngleLevelAxis(
      kPitchAxis, output.desired_pitch_rad, measured_angles.y,
      measured_rate.y, step_seconds, output);

  // TRZTorqueController suppresses yaw while the vehicle is too vertical.
  if (std::abs(measured_angles.y) >
      kPi / 2.0 - parameters_.fixed_wing_minimum_pitch_rad) {
    output.controls.yaw = 0.0;
  } else if (yaw_mode == YawGoalMode::angle) {
    output.controls.yaw = UpdateAngleLevelAxis(
        kYawAxis, yaw_value, measured_angles.z, measured_rate.z,
        step_seconds, output);
  } else {
    output.desired_yaw_rate_body_radps = yaw_value;
    output.controls.yaw = angle_rate_pid_[kYawAxis].Update(
        yaw_value, measured_rate.z, step_seconds);
  }

  // All three translational axes are velocity-mode axes for CommandVelocity
  // and CommandHeading. The legacy throttle controller therefore compares
  // requested velocity magnitude against full measured NED speed.
  output.desired_speed_mps = velocity_ned_mps.Norm();
  output.measured_speed_mps = measured_velocity.Norm();
  output.controls.throttle = std::max(
      0.0, speed_pid_.Update(output.desired_speed_mps,
                             output.measured_speed_mps, step_seconds));
  output.controls.tilt = 1.0;
  return output;
}

double TiltrotorFixedWingController::UpdateAngleLevelAxis(
    std::size_t axis, double goal_angle_rad, double measured_angle_rad,
    double measured_rate_radps, double step_seconds,
    TiltrotorFixedWingOutput& output) {
  AdjustToMinimumDistance(measured_angle_rad, goal_angle_rad);
  const double desired_rate = angle_level_pid_[axis].Update(
                                  goal_angle_rad, measured_angle_rad,
                                  step_seconds) *
                              parameters_.fixed_wing.angle_rate.maximum[axis];
  if (axis == kYawAxis) output.desired_yaw_rate_body_radps = desired_rate;
  return angle_rate_pid_[axis].Update(
      desired_rate, measured_rate_radps, step_seconds);
}

void TiltrotorFixedWingController::PrepareYawMode(YawGoalMode mode) {
  if (yaw_goal_mode_ == mode) return;
  angle_level_pid_[kYawAxis].Reset();
  angle_rate_pid_[kYawAxis].Reset();
  yaw_goal_mode_ = mode;
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
