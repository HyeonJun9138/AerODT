#include "aerodt/digital_twin/simulation/control/simple_flight/multirotor_cascade_controller.hpp"

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

void ValidateGoal(const PositionYawRateGoalNed& goal,
                  std::chrono::nanoseconds step) {
  if (!goal.position_ned_m.IsFinite() ||
      !std::isfinite(goal.yaw_rate_body_radps) || step.count() <= 0) {
    throw std::invalid_argument(
        "SimpleFlight position goal must be finite and step must be positive.");
  }
}

void ValidateGoal(const VelocityYawRateGoalNed& goal,
                  std::chrono::nanoseconds step) {
  if (!goal.velocity_ned_mps.IsFinite() ||
      !std::isfinite(goal.yaw_rate_body_radps) || step.count() <= 0) {
    throw std::invalid_argument(
        "SimpleFlight velocity/yaw-rate goal must be finite and step must be positive.");
  }
}

void ValidateGoal(const VelocityYawAngleGoalNed& goal,
                  std::chrono::nanoseconds step) {
  if (!goal.velocity_ned_mps.IsFinite() ||
      !std::isfinite(goal.yaw_angle_ned_rad) || step.count() <= 0) {
    throw std::invalid_argument(
        "SimpleFlight velocity/yaw-angle goal must be finite and step must be positive.");
  }
}

}  // namespace

MultirotorCascadeController::MultirotorCascadeController(
    CascadeParameters parameters)
    : parameters_(std::move(parameters)),
      position_pid_(MakeControllers(parameters_.position)),
      velocity_pid_(MakeControllers(parameters_.velocity)),
      angle_level_pid_(MakeControllers(parameters_.angle_level)),
      angle_rate_pid_(MakeControllers(parameters_.angle_rate)) {
  if (!std::isfinite(parameters_.minimum_throttle) ||
      parameters_.minimum_throttle < 0.0 || parameters_.minimum_throttle > 1.0) {
    throw std::invalid_argument("SimpleFlight minimum throttle must be in [0, 1].");
  }
  Reset();
}

void MultirotorCascadeController::Reset() {
  for (std::size_t axis = 0; axis < kControlAxisCount; ++axis) {
    position_pid_[axis].Reset();
    velocity_pid_[axis].Reset();
    angle_level_pid_[axis].Reset();
    angle_rate_pid_[axis].Reset();
  }
  translation_goal_mode_ = TranslationGoalMode::unknown;
  yaw_goal_mode_ = YawGoalMode::unknown;
}

void MultirotorCascadeController::ClearHorizontalVelocityIntegral() noexcept {
  velocity_pid_[kRollAxis].ClearIntegral();
  velocity_pid_[kPitchAxis].ClearIntegral();
}

MultirotorCascadeOutput MultirotorCascadeController::Update(
    const PositionYawRateGoalNed& goal,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  ValidateGoal(goal, step);
  PrepareGoalModes(TranslationGoalMode::position, YawGoalMode::rate);
  const double step_seconds = std::chrono::duration<double>(step).count();
  const GroundTruthStateEstimator estimate(state);
  const auto measured_angles = estimate.RollPitchYawRad();
  const auto measured_velocity_body =
      estimate.TransformNedToBody(estimate.LinearVelocityNed());
  const auto measured_rate = estimate.AngularVelocityBody();

  MultirotorCascadeOutput output;

  // Axis 0 is NED Y -> body Y -> positive roll.
  output.desired_velocity_ned_mps.y =
      position_pid_[kRollAxis].Update(
          goal.position_ned_m.y, estimate.PositionNed().y, step_seconds) *
      parameters_.velocity.maximum[kRollAxis];
  const auto roll_velocity_body = estimate.TransformNedToBody(
      {0.0, output.desired_velocity_ned_mps.y, 0.0});
  const double roll_velocity_output = velocity_pid_[kRollAxis].Update(
      roll_velocity_body.y, measured_velocity_body.y, step_seconds);
  output.desired_roll_pitch_yaw_rad.x =
      roll_velocity_output * parameters_.angle_level.maximum[kRollAxis];
  output.controls.roll = UpdateAngleLevelAxis(
      kRollAxis, output.desired_roll_pitch_yaw_rad.x, measured_angles.x,
      measured_rate.x, step_seconds, output);

  // Axis 1 is NED X -> body X -> negative pitch.
  output.desired_velocity_ned_mps.x =
      position_pid_[kPitchAxis].Update(
          goal.position_ned_m.x, estimate.PositionNed().x, step_seconds) *
      parameters_.velocity.maximum[kPitchAxis];
  const auto pitch_velocity_body = estimate.TransformNedToBody(
      {output.desired_velocity_ned_mps.x, 0.0, 0.0});
  const double pitch_velocity_output = velocity_pid_[kPitchAxis].Update(
      pitch_velocity_body.x, measured_velocity_body.x, step_seconds);
  output.desired_roll_pitch_yaw_rad.y =
      -pitch_velocity_output * parameters_.angle_level.maximum[kPitchAxis];
  output.controls.pitch = UpdateAngleLevelAxis(
      kPitchAxis, output.desired_roll_pitch_yaw_rad.y, measured_angles.y,
      measured_rate.y, step_seconds, output);

  // Axis 2 remains an angle-rate controller in position mode.
  output.desired_angular_velocity_body_radps.z = goal.yaw_rate_body_radps;
  output.controls.yaw = angle_rate_pid_[kYawAxis].Update(
      goal.yaw_rate_body_radps, measured_rate.z, step_seconds);

  // Axis 3 is NED Z; positive down velocity maps to lower throttle.
  output.desired_velocity_ned_mps.z =
      position_pid_[kThrottleAxis].Update(
          goal.position_ned_m.z, estimate.PositionNed().z, step_seconds) *
      parameters_.velocity.maximum[kThrottleAxis];
  const auto throttle_velocity_body = estimate.TransformNedToBody(
      {0.0, 0.0, output.desired_velocity_ned_mps.z});
  const double throttle_velocity_output = velocity_pid_[kThrottleAxis].Update(
      throttle_velocity_body.z, measured_velocity_body.z, step_seconds);
  output.controls.throttle = std::max(
      (-throttle_velocity_output + 1.0) / 2.0,
      parameters_.minimum_throttle);
  output.controls.tilt = 0.0;
  return output;
}

MultirotorCascadeOutput MultirotorCascadeController::Update(
    const VelocityYawRateGoalNed& goal,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  ValidateGoal(goal, step);
  return UpdateVelocity(goal.velocity_ned_mps, YawGoalMode::rate,
                        goal.yaw_rate_body_radps, state, step);
}

MultirotorCascadeOutput MultirotorCascadeController::Update(
    const VelocityYawAngleGoalNed& goal,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  ValidateGoal(goal, step);
  return UpdateVelocity(goal.velocity_ned_mps, YawGoalMode::angle,
                        goal.yaw_angle_ned_rad, state, step);
}

MultirotorCascadeOutput MultirotorCascadeController::UpdateVelocity(
    const foundation::math::Vector3& velocity_ned_mps,
    YawGoalMode yaw_mode, double yaw_value,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  PrepareGoalModes(TranslationGoalMode::velocity, yaw_mode);
  const double step_seconds = std::chrono::duration<double>(step).count();
  const GroundTruthStateEstimator estimate(state);
  const auto measured_angles = estimate.RollPitchYawRad();
  const auto goal_velocity_body = estimate.TransformNedToBody(velocity_ned_mps);
  const auto measured_velocity_body =
      estimate.TransformNedToBody(estimate.LinearVelocityNed());
  const auto measured_rate = estimate.AngularVelocityBody();

  MultirotorCascadeOutput output;
  output.desired_velocity_ned_mps = velocity_ned_mps;

  const double roll_velocity_output = velocity_pid_[kRollAxis].Update(
      goal_velocity_body.y, measured_velocity_body.y, step_seconds);
  output.desired_roll_pitch_yaw_rad.x =
      roll_velocity_output * parameters_.angle_level.maximum[kRollAxis];
  output.controls.roll = UpdateAngleLevelAxis(
      kRollAxis, output.desired_roll_pitch_yaw_rad.x, measured_angles.x,
      measured_rate.x, step_seconds, output);

  const double pitch_velocity_output = velocity_pid_[kPitchAxis].Update(
      goal_velocity_body.x, measured_velocity_body.x, step_seconds);
  output.desired_roll_pitch_yaw_rad.y =
      -pitch_velocity_output * parameters_.angle_level.maximum[kPitchAxis];
  output.controls.pitch = UpdateAngleLevelAxis(
      kPitchAxis, output.desired_roll_pitch_yaw_rad.y, measured_angles.y,
      measured_rate.y, step_seconds, output);

  if (yaw_mode == YawGoalMode::angle) {
    output.desired_roll_pitch_yaw_rad.z = yaw_value;
    output.controls.yaw = UpdateAngleLevelAxis(
        kYawAxis, yaw_value, measured_angles.z, measured_rate.z,
        step_seconds, output);
  } else {
    output.desired_angular_velocity_body_radps.z = yaw_value;
    output.controls.yaw = angle_rate_pid_[kYawAxis].Update(
        yaw_value, measured_rate.z, step_seconds);
  }

  // The vertical goal is NED down, not velocity along the tilted rotor axis.
  // Projecting horizontal tracking error onto body Z asked for extra climb
  // thrust whenever the aircraft pitched forward to accelerate on approach.
  const double throttle_velocity_output = velocity_pid_[kThrottleAxis].Update(
      velocity_ned_mps.z, estimate.LinearVelocityNed().z, step_seconds);
  output.controls.throttle = std::max(
      (-throttle_velocity_output + 1.0) / 2.0,
      parameters_.minimum_throttle);
  output.controls.tilt = 0.0;
  return output;
}

double MultirotorCascadeController::UpdateAngleLevelAxis(
    std::size_t axis, double goal_angle_rad, double measured_angle_rad,
    double measured_rate_radps, double step_seconds,
    MultirotorCascadeOutput& output) {
  AdjustToMinimumDistance(measured_angle_rad, goal_angle_rad);
  const double desired_rate = angle_level_pid_[axis].Update(
                                  goal_angle_rad, measured_angle_rad,
                                  step_seconds) *
                              parameters_.angle_rate.maximum[axis];
  if (axis == kRollAxis) {
    output.desired_angular_velocity_body_radps.x = desired_rate;
  } else if (axis == kPitchAxis) {
    output.desired_angular_velocity_body_radps.y = desired_rate;
  } else if (axis == kYawAxis) {
    output.desired_angular_velocity_body_radps.z = desired_rate;
  }
  return angle_rate_pid_[axis].Update(
      desired_rate, measured_rate_radps, step_seconds);
}

void MultirotorCascadeController::PrepareGoalModes(
    TranslationGoalMode translation_mode, YawGoalMode yaw_mode) {
  if (translation_goal_mode_ != translation_mode) {
    ResetTranslationControllers();
    translation_goal_mode_ = translation_mode;
  }
  if (yaw_goal_mode_ != yaw_mode) {
    ResetYawControllers();
    yaw_goal_mode_ = yaw_mode;
  }
}

void MultirotorCascadeController::ResetTranslationControllers() {
  for (const auto axis : {kRollAxis, kPitchAxis, kThrottleAxis}) {
    position_pid_[axis].Reset();
    velocity_pid_[axis].Reset();
    if (axis != kThrottleAxis) {
      angle_level_pid_[axis].Reset();
      angle_rate_pid_[axis].Reset();
    }
  }
}

void MultirotorCascadeController::ResetYawControllers() {
  angle_level_pid_[kYawAxis].Reset();
  angle_rate_pid_[kYawAxis].Reset();
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
