#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

#include "aerodt/digital_twin/simulation/control/simple_flight/flight_mode_transition.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/ground_truth_state_estimator.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/multirotor_cascade_controller.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/pid_controller.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_parameters.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_cascade_controller.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_fixed_wing_controller.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_mixer.hpp"

namespace {

using aerodt::digital_twin::simulation::control::simple_flight::ControlAxes;
using aerodt::digital_twin::simulation::control::simple_flight::FlightMode;
using aerodt::digital_twin::simulation::control::simple_flight::FlightModeTransition;
using aerodt::digital_twin::simulation::control::simple_flight::GroundTruthStateEstimator;
using aerodt::digital_twin::simulation::control::simple_flight::LoadSimpleFlightParameters;
using aerodt::digital_twin::simulation::control::simple_flight::MultirotorCascadeController;
using aerodt::digital_twin::simulation::control::simple_flight::PidController;
using aerodt::digital_twin::simulation::control::simple_flight::PidParameters;
using aerodt::digital_twin::simulation::control::simple_flight::PositionYawRateGoalNed;
using aerodt::digital_twin::simulation::control::simple_flight::TiltrotorMixer;
using aerodt::digital_twin::simulation::control::simple_flight::TiltrotorCascadeController;
using aerodt::digital_twin::simulation::control::simple_flight::TiltrotorFixedWingController;
using aerodt::digital_twin::simulation::control::simple_flight::VelocityYawAngleGoalNed;
using aerodt::digital_twin::simulation::control::simple_flight::VelocityYawRateGoalNed;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("SimpleFlight parity assertion failed.");
  }
}

void TestManualVerticalModelParameters() {
  Near(LoadSimpleFlightParameters({},false).manual_vertical.velocity_p,0,0,"manual opt-in");
  const std::unordered_map<std::string,double> values{
    {"MANUAL_Z_VEL_P",2.4},{"MANUAL_Z_VEL_I",.8},{"MANUAL_Z_POS_P",.6},
    {"MANUAL_Z_ACCEL_MAX",3},{"MANUAL_Z_COMMAND_ACCEL",.6},
    {"MANUAL_Z_CLIMB_SPEED",.8},{"MANUAL_Z_DESCENT_SPEED",.6}};
  const auto p=LoadSimpleFlightParameters(values,true).manual_vertical;
  Near(p.velocity_p,2.4,1e-12,"manual velocity gain");
  Near(p.climb_speed,.8,1e-12,"manual climb limit");
  Near(p.descent_speed,.6,1e-12,"manual descent limit");
  for(const auto& [key,value]:values) {
    for(double invalid : {-1.,std::numeric_limits<double>::quiet_NaN()}) {
      auto bad=values;bad[key]=invalid;bool rejected=false;
      try { static_cast<void>(LoadSimpleFlightParameters(bad,true)); }
      catch(const std::invalid_argument&) { rejected=true; }
      if(!rejected) throw std::runtime_error("Invalid manual vertical model accepted.");
    }
  }
  bool rejected=false;
  try { static_cast<void>(LoadSimpleFlightParameters({{"MANUAL_Z_VEL_P",2.4}},true)); }
  catch(const std::invalid_argument&) { rejected=true; }
  if(!rejected) throw std::runtime_error("Incomplete manual vertical model accepted.");
}

void TestPidMatchesSimpleFlightTerms() {
  PidController pid({
      .proportional_gain = 2.0,
      .integral_gain = 0.5,
      .derivative_gain = 0.25,
      .minimum_output = -10.0,
      .maximum_output = 10.0,
  });
  pid.Reset(1.0, 0.0);
  Near(pid.Update(1.0, 0.0, 0.1), 2.05, 1e-12, "pid first output");
  Near(pid.Update(1.0, 0.5, 0.1), -0.175, 1e-12, "pid second output");
}

void TestPidIntegralWindupLimit() {
  PidController pid({
      .integral_gain = 10.0,
      .minimum_output = -1.0,
      .maximum_output = 1.0,
  });
  pid.Reset();
  static_cast<void>(pid.Update(1.0, 0.0, 1.0));
  Near(pid.IntegralTerm(), 1.0, 1e-12, "integral clamp");
  Near(pid.Output(), 1.0, 1e-12, "output clamp");
}

void TestMultirotorHoverMix() {
  const TiltrotorMixer mixer;
  const auto output = mixer.Mix({.throttle = 0.5, .tilt = 0.0});
  if (output.size() != 11) throw std::runtime_error("AirTaxi actuator count changed.");
  for (int rotor = 0; rotor < 4; ++rotor) Near(output[rotor], 0.5, 1e-12, "hover rotor");
  for (int tilt = 4; tilt < 8; ++tilt) Near(output[tilt], 0.0, 1e-12, "hover tilt");
}

void TestFixedWingMixMatchesProjectAirSimMatrix() {
  const TiltrotorMixer mixer;
  const auto output = mixer.Mix({.roll = 0.2, .pitch = 0.3, .yaw = 0.4,
                                 .throttle = 0.5, .tilt = 1.0});
  Near(output[0], 0.3, 1e-12, "fixed-wing rotor FR");
  Near(output[1], 0.7, 1e-12, "fixed-wing rotor RL");
  Near(output[2], 0.7, 1e-12, "fixed-wing rotor FL");
  Near(output[3], 0.3, 1e-12, "fixed-wing rotor RR");
  for (int tilt = 4; tilt < 8; ++tilt) Near(output[tilt], 1.0, 1e-12, "fixed-wing tilt");
  Near(output[8], -0.2, 1e-12, "left aileron");
  Near(output[9], 0.2, 1e-12, "right aileron");
  Near(output[10], 0.3, 1e-12, "elevator");
}

void TestRotorDesaturationPreservesRatios() {
  const TiltrotorMixer mixer;
  const auto output = mixer.Mix({.roll = 1.0, .throttle = 1.0});
  for (int rotor = 0; rotor < 4; ++rotor) {
    if (output[rotor] < 0.0 || output[rotor] > 1.0) {
      throw std::runtime_error("Rotor output escaped normalized range.");
    }
  }
  Near(output[1], 1.0, 1e-12, "desaturated maximum");
  Near(output[2], 1.0, 1e-12, "desaturated maximum pair");
}

void TestTiltrotorFlightModeTransition() {
  FlightModeTransition transition({
      .stall_speed_mps = 2.0,
      .speed_transition_mps = 2.5,
      .confirmation_count = 10,
      .transition_duration = std::chrono::seconds(5),
  });

  for (int count = 0; count < 8; ++count) {
    const auto output = transition.Update(5.0, true, std::chrono::seconds(1));
    if (output.mode != FlightMode::multirotor || output.fixed_wing_blend != 0.0) {
      throw std::runtime_error("Fixed-wing mode changed before speed confirmation.");
    }
  }
  auto output = transition.Update(5.0, true, std::chrono::seconds(1));
  if (output.mode != FlightMode::fixed_wing || output.speed_confirmation_count != 9) {
    throw std::runtime_error("Fixed-wing mode did not change at the legacy threshold.");
  }
  Near(output.fixed_wing_blend, 0.0, 1e-12, "blend on fixed-wing switch tick");

  for (int count = 0; count < 5; ++count) {
    output = transition.Update(5.0, true, std::chrono::seconds(1));
  }
  Near(output.fixed_wing_blend, 1.0, 1e-12, "completed fixed-wing blend");

  output = transition.Update(3.0, true, std::chrono::seconds(1));
  if (output.mode != FlightMode::fixed_wing) {
    throw std::runtime_error("Transition hysteresis did not retain fixed-wing mode.");
  }

  for (int count = 0; count < 9; ++count) {
    output = transition.Update(2.0, true, std::chrono::milliseconds(500));
  }
  if (output.mode != FlightMode::multirotor || output.speed_confirmation_count > 1) {
    throw std::runtime_error("Low speed did not initiate multirotor transition.");
  }
  Near(output.fixed_wing_blend, 1.0, 1e-12, "blend on multirotor switch tick");
  output = transition.Update(2.0, true, std::chrono::milliseconds(500));
  Near(output.fixed_wing_blend, 0.9, 1e-12, "multirotor transition blend");

  transition.Reset();
  output = transition.Update(5.0, false, std::chrono::seconds(1));
  if (output.mode != FlightMode::multirotor || output.fixed_wing_blend != 0.0) {
    throw std::runtime_error("Disabled fixed-wing mode changed the flight mode.");
  }
}

void TestGroundTruthEstimatorMatchesNedBodyConvention() {
  using aerodt::digital_twin::contracts::VehicleState;
  using aerodt::foundation::math::Quaternion;
  constexpr double kPi = 3.141592653589793238462643383279502884;
  VehicleState state;
  state.orientation_body_to_ned =
      Quaternion::FromAxisAngle({0.0, 0.0, 1.0}, kPi / 2.0);
  const GroundTruthStateEstimator estimator(state);
  const auto rpy = estimator.RollPitchYawRad();
  Near(rpy.x, 0.0, 1e-12, "estimator roll");
  Near(rpy.y, 0.0, 1e-12, "estimator pitch");
  Near(rpy.z, kPi / 2.0, 1e-12, "estimator yaw");
  const auto body = estimator.TransformNedToBody({1.0, 0.0, 0.0});
  Near(body.x, 0.0, 1e-12, "NED north in yawed body X");
  Near(body.y, -1.0, 1e-12, "NED north in yawed body Y");
  Near(body.z, 0.0, 1e-12, "NED north in yawed body Z");
}

void TestTypedParametersApplyLegacyDefaultsAndOverrides() {
  const auto parameters = LoadSimpleFlightParameters(
      {{"MC_ROLLRATE_MAX", 0.3},
       {"MC_YAWRATE_P", 1.2},
       {"MPC_XY_P", 0.05},
       {"MPC_MIN_THR", 0.001},
       {"FW_AIRSPD_STALL", 2.0},
       {"FW_Y_RMAX", 1.0},
       {"FW_Z_VEL_P", 0.07}},
      true);
  Near(parameters.multirotor.angle_rate.maximum[0], 0.3, 1e-12,
       "multirotor roll-rate maximum");
  Near(parameters.multirotor.angle_rate.pid[2].proportional_gain, 1.2, 1e-12,
       "multirotor yaw-rate P");
  Near(parameters.multirotor.position.pid[0].proportional_gain, 0.05, 1e-12,
       "multirotor XY position P");
  Near(parameters.multirotor.velocity.pid[3].integral_gain, 2.0, 1e-12,
       "legacy Z velocity I default");
  Near(parameters.multirotor.minimum_throttle, 0.001, 1e-12,
       "multirotor minimum throttle");
  Near(parameters.fixed_wing_stall_speed_mps, 2.0, 1e-12,
       "fixed-wing stall speed");
  Near(parameters.fixed_wing.angle_rate.maximum[2], 1.0, 1e-12,
       "fixed-wing yaw-rate maximum");
  Near(parameters.fixed_wing.velocity.pid[3].proportional_gain, 0.07, 1e-12,
       "fixed-wing Z velocity P");
  if (!parameters.fixed_wing_capable) {
    throw std::runtime_error("Tiltrotor package did not declare fixed-wing capability.");
  }
}

void TestMultirotorPositionCascadeMatchesLegacyAxisMath() {
  using aerodt::digital_twin::contracts::VehicleState;
  constexpr double kPi = 3.141592653589793238462643383279502884;
  const auto parameters = LoadSimpleFlightParameters({}, false);
  MultirotorCascadeController controller(parameters.multirotor);
  const auto output = controller.Update(
      PositionYawRateGoalNed{
          .position_ned_m = {1.0, 1.0, -1.0},
          .yaw_rate_body_radps = 0.1,
      },
      VehicleState{}, std::chrono::milliseconds(100));

  Near(output.desired_velocity_ned_mps.x, 1.5, 1e-12,
       "position-to-forward velocity");
  Near(output.desired_velocity_ned_mps.y, 1.5, 1e-12,
       "position-to-right velocity");
  Near(output.desired_velocity_ned_mps.z, -1.5, 1e-12,
       "position-to-up velocity");
  const double expected_axis_control =
      0.3 * (kPi / 5.5) * 2.5 * 2.5 * 0.25;
  Near(output.controls.roll, expected_axis_control, 1e-12,
       "right position to positive roll control");
  Near(output.controls.pitch, -expected_axis_control, 1e-12,
       "forward position to negative pitch control");
  Near(output.controls.yaw, 0.025, 1e-12, "yaw-rate control");
  Near(output.controls.throttle, 1.0, 1e-12, "up position to throttle");
  Near(output.controls.tilt, 0.0, 1e-12, "multirotor tilt control");
}

void TestMultirotorVelocityCascadeMatchesLegacyAxisMath() {
  using aerodt::digital_twin::contracts::VehicleState;
  constexpr double kPi = 3.141592653589793238462643383279502884;
  const auto parameters = LoadSimpleFlightParameters({}, false);
  MultirotorCascadeController controller(parameters.multirotor);
  const auto output = controller.Update(
      VelocityYawAngleGoalNed{
          .velocity_ned_mps = {1.0, 1.0, -1.0},
          .yaw_angle_ned_rad = 0.1,
      },
      VehicleState{}, std::chrono::milliseconds(100));

  const double expected_axis_control =
      0.2 * (kPi / 5.5) * 2.5 * 2.5 * 0.25;
  Near(output.controls.roll, expected_axis_control, 1e-12,
       "right velocity to positive roll control");
  Near(output.controls.pitch, -expected_axis_control, 1e-12,
       "forward velocity to negative pitch control");
  Near(output.controls.yaw, 0.1 * 2.5 * 2.5 * 0.25, 1e-12,
       "yaw-angle cascade control");
  Near(output.controls.throttle, 1.0, 1e-12,
       "up velocity to throttle");
}

void TestHorizontalVelocityErrorDoesNotCommandVerticalThrust() {
  auto parameters = LoadSimpleFlightParameters({}, false).multirotor;
  for (double pitch : {-0.5, 0.5}) {
    aerodt::digital_twin::contracts::VehicleState state{};
    state.orientation_body_to_ned = aerodt::foundation::math::Quaternion::FromAxisAngle(
        {0, 1, 0}, pitch);
    state.linear_velocity_ned_mps = {4, 0, 0};
    MultirotorCascadeController maintaining(parameters), accelerating(parameters);
    const auto hold = maintaining.Update(
        VelocityYawAngleGoalNed{.velocity_ned_mps = {4, 0, 0}}, state,
        std::chrono::milliseconds(4));
    const auto move = accelerating.Update(
        VelocityYawAngleGoalNed{.velocity_ned_mps = {10, 0, 0}}, state,
        std::chrono::milliseconds(4));
    Near(move.controls.throttle, hold.controls.throttle, 1e-12,
         "same NED vertical error must not become climb thrust when horizontal intent changes");
    for (double down : {0.0, 0.2}) {
      state.linear_velocity_ned_mps.z = 0.1;
      MultirotorCascadeController vertical(parameters);
      const auto correction = vertical.Update(
          VelocityYawRateGoalNed{.velocity_ned_mps = {10, 0, down}}, state,
          std::chrono::milliseconds(4));
      Near(correction.controls.throttle, (1.0 - (down - 0.1) * (2.0 + 2.0 * 0.004)) / 2.0,
           1e-12, "both vertical error signs retain their NED throttle response while pitched");
    }
  }
}

void TestRotorAssistKeepsMultirotorAllocation() {
  const TiltrotorMixer mixer;
  const auto hover = mixer.Mix({.roll = .1, .pitch = .2, .throttle = .5});
  const auto assist = mixer.Mix({.roll = .1, .pitch = .2, .throttle = .5,
                                 .tilt = 14.0 / 90.0, .allocation_blend = 0.0});
  for (int rotor = 0; rotor < 4; ++rotor)
    Near(assist[rotor], hover[rotor], 1e-12, "assist preserves rotor attitude allocation");
  for (int tilt = 4; tilt < 8; ++tilt)
    Near(assist[tilt], 14.0 / 90.0, 1e-12, "assist nacelle command");
  Near(assist[8], 0, 1e-12, "assist does not activate wing ailerons");
  for (double yaw : {-1.0, 1.0}) {
    const auto turning = mixer.Mix({.yaw = yaw, .throttle = .5, .tilt = 14.0 / 90.0,
        .allocation_blend = 0.0, .collective_tilt_only = true});
    for (int tilt = 4; tilt < 8; ++tilt)
      Near(turning[tilt], 14.0 / 90.0, 1e-12, "assist bounds every nacelle, not only their average");
    if (turning[0] == turning[2])
      throw std::runtime_error("collective tilt must retain rotor torque yaw authority");
  }
}

void TestRotorAssistIsOptInBoundedAndReturnsToVertical() {
  auto parameters = LoadSimpleFlightParameters({}, true);
  constexpr double pi = 3.141592653589793;
  parameters.rotor_assist_maximum_rad = 14 * pi / 180;
  parameters.rotor_assist_rate_radps = 2 * pi / 180;
  TiltrotorCascadeController controller(parameters);
  aerodt::digital_twin::contracts::VehicleState state{};
  VelocityYawAngleGoalNed goal{.velocity_ned_mps = {10, 0, 0}};
  auto output = controller.Update(goal, false, state, std::chrono::seconds(1));
  Near(output.controls.tilt, 0, 1e-12, "hover does not opt into rotor assist");
  goal.allow_rotor_tilt_assist = true;
  for (int i = 1; i <= 10; ++i) {
    output = controller.Update(goal, false, state, std::chrono::seconds(1));
    Near(output.controls.tilt * 90, std::min(14, 2 * i), 1e-10, "assist rate and limit");
    Near(output.transition.fixed_wing_blend, 0, 1e-12, "assist is not a wing transition");
    Near(output.controls.allocation_blend.value_or(-1), 0, 1e-12, "assist keeps rotor mixer");
  }
  goal.allow_rotor_tilt_assist = false;
  for (int i = 1; i <= 8; ++i) {
    output = controller.Update(goal, false, state, std::chrono::seconds(1));
    Near(output.controls.tilt * 90, std::max(0, 14 - 2 * i), 1e-10, "assist returns smoothly to vertical");
  }
  controller.Reset();
  goal.allow_rotor_tilt_assist = true;
  goal.velocity_ned_mps = {-10, 0, 0};
  output = controller.Update(goal, false, state, std::chrono::seconds(1));
  Near(output.controls.tilt, 0, 1e-12, "backward intent must not tilt forward");
  if (!output.controls.collective_tilt_only)
    throw std::runtime_error("slow/turning approach must not toggle yaw nacelle differential back on");
  controller.Reset();
  goal.velocity_ned_mps = {10, 0, 0};
  state.linear_velocity_ned_mps = {30, 0, 0};
  output = controller.Update(goal, true, state, std::chrono::seconds(1));
  Near(output.controls.tilt, 0, 1e-12, "wing request never uses rotor assist");
}

void TestConditionalIntegralDoesNotAccumulateIntoPitchSaturation() {
  PidController pid({.proportional_gain = .2, .integral_gain = .04,
                     .conditional_integration = true});
  for (int i = 0; i < 10000; ++i) (void)pid.Update(10, 6, .004);
  if (pid.IntegralTerm() > .201)
    throw std::runtime_error("saturated forward pitch must not accumulate hidden braking debt");
  if (pid.Update(5, 6, .004) > .001)
    throw std::runtime_error("deceleration must take effect immediately after saturation");
}

void TestInactiveRotorVelocityIntegralDoesNotWindUpOnTheWing() {
  auto parameters = LoadSimpleFlightParameters({}, true);
  parameters.transition_duration = std::chrono::milliseconds(100);
  parameters.multirotor.velocity.pid[1].integral_gain = 0.04;
  TiltrotorCascadeController controller(parameters);
  aerodt::digital_twin::contracts::VehicleState state{};
  state.linear_velocity_ned_mps = {30, 0, 0};
  VelocityYawAngleGoalNed goal{.velocity_ned_mps = {31, 0, 0}};
  for (int i = 0; i < 1000; ++i)
    (void)controller.Update(goal, true, state, std::chrono::milliseconds(4));
  const auto reversing = controller.Update(goal, false, state, std::chrono::milliseconds(4));
  const double proportional_pitch = -0.2 * parameters.multirotor.angle_level.maximum[1];
  Near(reversing.multirotor.desired_roll_pitch_yaw_rad.y, proportional_pitch, .001,
       "inactive multirotor integral must not carry wing-flight errors into reversal");
}

void TestTiltrotorFixedWingVelocityControllerMatchesLegacyMath() {
  using aerodt::digital_twin::contracts::VehicleState;
  const auto parameters = LoadSimpleFlightParameters(
      {{"FW_PITCH_MAX", 0.262},
       {"FW_Z_VEL_P", 0.07},
       {"FW_Z_VEL_I", 0.02},
       {"FW_Z_VEL_D", 0.05}},
      true);
  TiltrotorFixedWingController controller(parameters);
  const auto output = controller.Update(
      VelocityYawAngleGoalNed{
          .velocity_ned_mps = {10.0, 0.0, -1.0},
          .yaw_angle_ned_rad = 0.0,
      },
      VehicleState{}, std::chrono::milliseconds(100));

  // Vertical error -1 produces -(P + I + D) = -0.572, then the
  // tiltrotor controller negates it into a positive pitch goal.
  Near(output.desired_pitch_rad, 0.572 * 0.262, 1e-12,
       "fixed-wing vertical velocity to pitch");
  Near(output.controls.pitch, 0.572 * 0.262 * 2.5 * 2.5 * 0.25,
       1e-12, "fixed-wing pitch cascade");
  Near(output.controls.roll, 0.0, 1e-12,
       "fixed-wing velocity command holds zero roll");
  Near(output.controls.yaw, 0.0, 1e-12,
       "fixed-wing heading hold");
  Near(output.controls.throttle, 1.0, 1e-12,
       "fixed-wing speed throttle");
  Near(output.controls.tilt, 1.0, 1e-12,
       "fixed-wing branch tilt diagnostic");
}

void TestTiltrotorFixedWingYawUsesShortestPathAndVerticalGuard() {
  using aerodt::digital_twin::contracts::VehicleState;
  using aerodt::foundation::math::Quaternion;
  constexpr double kPi = 3.141592653589793238462643383279502884;
  TiltrotorFixedWingController controller(
      LoadSimpleFlightParameters({}, true));

  VehicleState state;
  state.orientation_body_to_ned = Quaternion::FromAxisAngle(
      {0.0, 0.0, 1.0}, -179.0 * kPi / 180.0);
  auto output = controller.Update(
      VelocityYawAngleGoalNed{
          .velocity_ned_mps = {},
          .yaw_angle_ned_rad = 179.0 * kPi / 180.0,
      },
      state, std::chrono::milliseconds(100));
  if (!(output.controls.yaw < 0.0)) {
    throw std::runtime_error(
        "Fixed-wing heading controller did not use the shortest yaw path.");
  }

  controller.Reset();
  state = {};
  state.orientation_body_to_ned =
      Quaternion::FromAxisAngle({0.0, 1.0, 0.0}, 1.4);
  output = controller.Update(
      VelocityYawRateGoalNed{
          .velocity_ned_mps = {},
          .yaw_rate_body_radps = 1.0,
      },
      state, std::chrono::milliseconds(100));
  Near(output.controls.yaw, 0.0, 1e-12,
       "fixed-wing vertical-attitude yaw guard");
}

void TestTiltrotorControllerBlendsBothBranchesAfterSpeedConfirmation() {
  using aerodt::digital_twin::contracts::VehicleState;
  const auto parameters = LoadSimpleFlightParameters(
      {{"FW_AIRSPD_STALL", 2.0}, {"FW_Z_VEL_P", 0.07}}, true);
  TiltrotorCascadeController controller(parameters);
  VehicleState state;
  state.linear_velocity_ned_mps.x = 5.0;
  const VelocityYawRateGoalNed goal{
      .velocity_ned_mps = {5.0, 0.0, 0.0},
      .yaw_rate_body_radps = 0.1,
  };

  for (int count = 0; count < 8; ++count) {
    const auto output = controller.Update(
        goal, true, state, std::chrono::seconds(1));
    if (output.transition.mode != FlightMode::multirotor) {
      throw std::runtime_error("Tiltrotor controller switched too early.");
    }
  }
  auto output = controller.Update(goal, true, state, std::chrono::seconds(1));
  if (output.transition.mode != FlightMode::fixed_wing) {
    throw std::runtime_error("Tiltrotor controller did not enter fixed-wing mode.");
  }
  Near(output.controls.tilt, 0.0, 1e-12,
       "combined controller switch-tick tilt");

  output = controller.Update(goal, true, state, std::chrono::seconds(1));
  Near(output.transition.fixed_wing_blend, 0.2, 1e-12,
       "combined controller blend state");
  Near(output.controls.roll,
       output.multirotor.controls.roll * 0.8 +
           output.fixed_wing.controls.roll * 0.2,
       1e-12, "combined roll output");
  Near(output.controls.throttle,
       output.multirotor.controls.throttle * 0.8 +
           output.fixed_wing.controls.throttle * 0.2,
       1e-12, "combined throttle output");
  Near(output.controls.tilt, 0.2, 1e-12,
       "combined tilt output");

  TiltrotorCascadeController multirotor_only(
      LoadSimpleFlightParameters({{"FW_AIRSPD_STALL", 2.0}}, false));
  for (int count = 0; count < 12; ++count) {
    output = multirotor_only.Update(
        goal, true, state, std::chrono::seconds(1));
  }
  if (output.transition.mode != FlightMode::multirotor ||
      output.transition.fixed_wing_blend != 0.0) {
    throw std::runtime_error(
        "Runtime request bypassed the airframe fixed-wing capability.");
  }
}

void TestStartupEnvelopeIsOptionalAndResettable() {
  auto parameters = LoadSimpleFlightParameters({}, false);
  parameters.startup_initial_throttle = 0.08;
  parameters.startup_ramp = std::chrono::seconds(4);
  TiltrotorCascadeController controller(parameters);
  aerodt::digital_twin::contracts::VehicleState state;
  VelocityYawAngleGoalNed goal;
  const auto first = controller.Update(goal, false, state, std::chrono::seconds(1));
  const double u = 0.25;
  Near(first.controls.throttle,
       0.08 + (first.multirotor.controls.throttle - 0.08) * u * u * (3.0 - 2.0 * u),
       1e-12, "startup throttle envelope");
  controller.Reset();
  Near(controller.Update(goal, false, state, std::chrono::seconds(1)).controls.throttle,
       first.controls.throttle, 1e-12, "startup reset");
  parameters.startup_initial_throttle = -1.0;
  bool rejected = false;
  try { TiltrotorCascadeController invalid(parameters); }
  catch (const std::invalid_argument&) { rejected = true; }
  if (!rejected) throw std::runtime_error("Invalid startup throttle accepted.");
}

}  // namespace

int main() {
  try {
    TestManualVerticalModelParameters();
    TestStartupEnvelopeIsOptionalAndResettable();
    TestPidMatchesSimpleFlightTerms();
    TestPidIntegralWindupLimit();
    TestConditionalIntegralDoesNotAccumulateIntoPitchSaturation();
    TestMultirotorHoverMix();
    TestRotorAssistKeepsMultirotorAllocation();
    TestRotorAssistIsOptInBoundedAndReturnsToVertical();
    TestFixedWingMixMatchesProjectAirSimMatrix();
    TestRotorDesaturationPreservesRatios();
    TestTiltrotorFlightModeTransition();
    TestGroundTruthEstimatorMatchesNedBodyConvention();
    TestTypedParametersApplyLegacyDefaultsAndOverrides();
    TestMultirotorPositionCascadeMatchesLegacyAxisMath();
    TestMultirotorVelocityCascadeMatchesLegacyAxisMath();
    TestHorizontalVelocityErrorDoesNotCommandVerticalThrust();
    TestInactiveRotorVelocityIntegralDoesNotWindUpOnTheWing();
    TestTiltrotorFixedWingVelocityControllerMatchesLegacyMath();
    TestTiltrotorFixedWingYawUsesShortestPathAndVerticalGuard();
    TestTiltrotorControllerBlendsBothBranchesAfterSpeedConfirmation();
    std::cout << "AERODT_SIMPLE_FLIGHT_CORE=PASS\n";
    return 0;
  } catch (const std::exception& exception) {
    std::cerr << "AERODT_SIMPLE_FLIGHT_CORE=FAIL: " << exception.what() << '\n';
    return 1;
  }
}
