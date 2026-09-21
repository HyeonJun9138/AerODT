#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_cascade_controller.hpp"

#include <algorithm>
#include <cmath>
#include <utility>
#include <stdexcept>

#include "aerodt/digital_twin/simulation/control/simple_flight/ground_truth_state_estimator.hpp"

namespace aerodt::digital_twin::simulation::control::simple_flight {
namespace {
constexpr double kPi = 3.14159265358979323846;

double Interpolate(double multirotor, double fixed_wing, double blend) {
  return multirotor * (1.0 - blend) + fixed_wing * blend;
}

}  // namespace

TiltrotorCascadeController::TiltrotorCascadeController(
    SimpleFlightParameters parameters)
    : parameters_(std::move(parameters)),
      multirotor_(parameters_.multirotor),
      fixed_wing_(parameters_),
      transition_({
          .stall_speed_mps = parameters_.fixed_wing_stall_speed_mps,
          .speed_transition_mps = 2.5,
          .confirmation_count = 10,
          .transition_duration = parameters_.transition_duration,
      }) {
  if (parameters_.startup_ramp.count() < 0 ||
      !std::isfinite(parameters_.startup_initial_throttle) ||
      parameters_.startup_initial_throttle < 0.0 || parameters_.startup_initial_throttle > 1.0) {
    throw std::invalid_argument("SimpleFlight startup envelope is invalid.");
  }
  if (!std::isfinite(parameters_.rotor_assist_maximum_rad) ||
      parameters_.rotor_assist_maximum_rad < 0.0 ||
      parameters_.rotor_assist_maximum_rad > 14.0 * kPi / 180.0 + 1e-6 ||
      !std::isfinite(parameters_.rotor_assist_rate_radps) ||
      parameters_.rotor_assist_rate_radps < 0.0 ||
      (parameters_.rotor_assist_maximum_rad > 0.0 && parameters_.rotor_assist_rate_radps <= 0.0))
    throw std::invalid_argument("SimpleFlight rotor assistance requires a bounded angle and positive slew rate.");
  Reset();
}

void TiltrotorCascadeController::Reset() {
  startup_elapsed_ = std::chrono::nanoseconds::zero();
  assist_command_rad_ = 0.0;
  multirotor_.Reset();
  fixed_wing_.Reset();
  transition_.Reset();
}

TiltrotorCascadeOutput TiltrotorCascadeController::Update(
    const VelocityYawRateGoalNed& goal, bool fixed_wing_requested,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  if (fixed_wing_requested || transition_.State().fixed_wing_blend > 0.0)
    multirotor_.ClearHorizontalVelocityIntegral();
  auto multirotor = multirotor_.Update(goal, state, step);
  auto fixed_wing = fixed_wing_.Update(goal, state, step);
  return Blend(std::move(multirotor), std::move(fixed_wing),
               fixed_wing_requested, 0.0, state, step);
}

TiltrotorCascadeOutput TiltrotorCascadeController::Update(
    const VelocityYawAngleGoalNed& goal, bool fixed_wing_requested,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  if (fixed_wing_requested || transition_.State().fixed_wing_blend > 0.0)
    multirotor_.ClearHorizontalVelocityIntegral();
  auto multirotor = multirotor_.Update(goal, state, step);
  auto fixed_wing = fixed_wing_.Update(goal, state, step);
  double assist_target = 0.0;
  if (goal.allow_rotor_tilt_assist && !fixed_wing_requested &&
      parameters_.fixed_wing_capable && transition_.State().fixed_wing_blend < 0.001) {
    const double yaw = GroundTruthStateEstimator(state).RollPitchYawRad().z;
    // Forward projection in the horizontal plane, not the pitched body frame:
    // descent velocity and a turn across the nose must not add forward assist.
    const double forward = goal.velocity_ned_mps.x * std::cos(yaw) +
                           goal.velocity_ned_mps.y * std::sin(yaw);
    assist_target = parameters_.rotor_assist_maximum_rad *
                    std::clamp((forward - 2.0) / 8.0, 0.0, 1.0);
  }
  auto output = Blend(std::move(multirotor), std::move(fixed_wing),
                      fixed_wing_requested, assist_target, state, step);
  // Keep nacelles collective through a slow corner too. Momentarily losing
  // forward projection is not permission to reintroduce differential tilt.
  output.controls.collective_tilt_only = output.controls.collective_tilt_only ||
      (goal.allow_rotor_tilt_assist && parameters_.rotor_assist_maximum_rad > 0.0 &&
       parameters_.fixed_wing_capable && !fixed_wing_requested &&
       output.transition.fixed_wing_blend < 0.001);
  return output;
}

FlightModeTransitionOutput
TiltrotorCascadeController::TransitionState() const noexcept {
  return transition_.State();
}

TiltrotorCascadeOutput TiltrotorCascadeController::Blend(
    MultirotorCascadeOutput multirotor,
    TiltrotorFixedWingOutput fixed_wing,
    bool fixed_wing_requested,
    double assist_target_rad,
    const contracts::VehicleState& state,
    std::chrono::nanoseconds step) {
  const double horizontal_speed = std::hypot(
      state.linear_velocity_ned_mps.x, state.linear_velocity_ned_mps.y);
  const auto transition = transition_.Update(
      horizontal_speed,
      fixed_wing_requested && parameters_.fixed_wing_capable, step);
  const double blend = transition.fixed_wing_blend;
  const double assist_step = parameters_.rotor_assist_rate_radps *
                            std::chrono::duration<double>(step).count();
  assist_command_rad_ += std::clamp(assist_target_rad - assist_command_rad_,
                                    -assist_step, assist_step);

  ControlAxes controls{
      .roll = Interpolate(multirotor.controls.roll,
                          fixed_wing.controls.roll, blend),
      .pitch = Interpolate(multirotor.controls.pitch,
                           fixed_wing.controls.pitch, blend),
      .yaw = Interpolate(multirotor.controls.yaw,
                         fixed_wing.controls.yaw, blend),
      .throttle = Interpolate(multirotor.controls.throttle,
                              fixed_wing.controls.throttle, blend),
      .tilt = blend + (1.0 - blend) * assist_command_rad_ / (kPi / 2.0),
      .allocation_blend = blend,
      .collective_tilt_only = assist_command_rad_ > 0.0 || assist_target_rad > 0.0,
  };
  if (parameters_.startup_ramp.count() > 0 && startup_elapsed_ < parameters_.startup_ramp) {
    startup_elapsed_ += step;
    const double u = std::min(1.0, static_cast<double>(startup_elapsed_.count()) / parameters_.startup_ramp.count());
    controls.throttle = Interpolate(parameters_.startup_initial_throttle, controls.throttle, u * u * (3.0 - 2.0 * u));
  }
  return {
      .controls = controls,
      .multirotor = std::move(multirotor),
      .fixed_wing = std::move(fixed_wing),
      .transition = transition,
  };
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
