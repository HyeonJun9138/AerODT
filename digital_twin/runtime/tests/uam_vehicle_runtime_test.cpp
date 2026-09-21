#include <cmath>
#include <iostream>
#include <stdexcept>

#include "aerodt/digital_twin/runtime/uam_vehicle_runtime.hpp"

namespace {

using aerodt::digital_twin::runtime::LoadAeroDTAirTaxiRuntimeConfig;
using aerodt::digital_twin::runtime::UamVehicleRuntime;
using aerodt::digital_twin::simulation::control::simple_flight::ControlAxes;
using aerodt::digital_twin::simulation::control::simple_flight::FlightMode;
using aerodt::digital_twin::simulation::control::simple_flight::PositionYawRateGoalNed;
using aerodt::digital_twin::simulation::control::simple_flight::VelocityYawAngleGoalNed;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("Native UAM runtime assertion failed.");
  }
}

const auto& RotorById(const auto& outputs, const char* id) {
  for (const auto& output : outputs) {
    if (output.id == id) return output.value;
  }
  throw std::runtime_error("Expected rotor output was not found.");
}

void TestRuntimePreservesPreviousWrenchOrder() {
  UamVehicleRuntime runtime(LoadAeroDTAirTaxiRuntimeConfig());
  const ControlAxes full_throttle{.throttle = 1.0};

  const auto first = runtime.Advance(full_throttle);
  if (first.state.entity_id != "UAM1" || first.state.vehicle.time.step != 1) {
    throw std::runtime_error("Runtime did not emit the configured entity snapshot.");
  }
  if (first.sensors.imu.size() != 1 || !first.sensors.gps.empty() ||
      !first.sensors.cameras.empty()) {
    throw std::runtime_error("Runtime sensor phase does not follow physics.");
  }
  Near(first.state.vehicle.position_ned_m.z, -4.0, 1e-12,
       "first-step position before gravity displacement");
  Near(first.state.vehicle.linear_acceleration_ned_mps2.z, 9.80665, 1e-12,
       "first-step acceleration uses zero previous wrench");
  if (!(first.next_step_wrench.force_ned_n.z < 0.0)) {
    throw std::runtime_error("Rotor wrench was not prepared for the next step.");
  }

  const auto second = runtime.Advance(full_throttle);
  if (second.state.vehicle.time.step != 2 ||
      !(second.state.vehicle.linear_acceleration_ned_mps2.z < 9.80665)) {
    throw std::runtime_error("Second physics step did not consume the pending rotor wrench.");
  }
}

void TestRuntimeMapsPackageActuatorIds() {
  UamVehicleRuntime runtime(LoadAeroDTAirTaxiRuntimeConfig());
  const auto tick = runtime.Advance({.roll = 0.2, .throttle = 0.5});

  // Actuator order is FR, RL, FL, RR while model declaration order starts at FL.
  const auto& front_right = RotorById(tick.rotors, "Prop_FR_actuator");
  const auto& front_left = RotorById(tick.rotors, "Prop_FL_actuator");
  if (!(front_left.filtered_control > front_right.filtered_control)) {
    throw std::runtime_error("Runtime mapped mixer rows by vector position instead of actuator ID.");
  }
  if (tick.tilts.size() != 4 || tick.control_surfaces.size() != 3 ||
      tick.actuator_commands.size() != 11) {
    throw std::runtime_error("Runtime omitted a configured UAM actuator.");
  }
}

void TestResetClearsPendingWrench() {
  UamVehicleRuntime runtime(LoadAeroDTAirTaxiRuntimeConfig());
  static_cast<void>(runtime.Advance({.throttle = 1.0}));
  runtime.Reset();
  Near(runtime.PendingWrench().force_ned_n.Norm(), 0.0, 1e-12,
       "pending wrench after reset");
  Near(runtime.State().position_ned_m.z, -4.0, 1e-12, "configured reset position");
  if (runtime.State().time.step != 0) {
    throw std::runtime_error("Runtime reset did not reset simulation time.");
  }
}

void TestPositionGoalRunsControllerInsideNativeTick() {
  UamVehicleRuntime runtime(LoadAeroDTAirTaxiRuntimeConfig());
  const auto tick = runtime.AdvancePositionGoal(PositionYawRateGoalNed{
      .position_ned_m = {1.0, 0.0, -5.0},
      .yaw_rate_body_radps = 0.1,
  });
  if (tick.state.vehicle.time.step != 1 ||
      !(tick.controller_output.pitch < 0.0) ||
      !(tick.controller_output.yaw > 0.0) ||
      !(tick.controller_output.throttle > 0.5)) {
    throw std::runtime_error(
        "Position goal was not converted to native SimpleFlight controls.");
  }
  Near(tick.controller_output.tilt, 0.0, 1e-12,
       "multirotor position controller tilt");
}

void TestVelocityGoalDrivesNativeTiltrotorTransition() {
  using aerodt::digital_twin::contracts::VehicleState;
  UamVehicleRuntime runtime(LoadAeroDTAirTaxiRuntimeConfig());
  VehicleState state;
  state.position_ned_m.z = -14.0;
  state.linear_velocity_ned_mps.x = 5.0;
  runtime.Reset(state);

  const VelocityYawAngleGoalNed goal{
      .velocity_ned_mps = {5.0, 0.0, 0.0},
      .yaw_angle_ned_rad = 0.0,
  };
  auto tick = runtime.AdvanceVelocityGoal(goal, true);
  for (int count = 1; count < 9; ++count) {
    tick = runtime.AdvanceVelocityGoal(goal, true);
  }
  if (tick.transition.mode != FlightMode::fixed_wing ||
      tick.transition.speed_confirmation_count != 9) {
    throw std::runtime_error(
        "Native runtime did not enter fixed-wing mode after speed confirmation.");
  }
  Near(tick.controller_output.tilt, 0.0, 1e-12,
       "runtime transition switch-tick tilt");

  tick = runtime.AdvanceVelocityGoal(goal, true);
  if (!(tick.transition.fixed_wing_blend > 0.0) ||
      !(tick.controller_output.tilt > 0.0) ||
      !(tick.actuator_commands[4] > 0.0)) {
    throw std::runtime_error(
        "Native runtime did not route transition blend to tilt actuators.");
  }

  tick = runtime.AdvanceVelocityGoal(goal, false);
  if (tick.transition.mode != FlightMode::multirotor) {
    throw std::runtime_error(
        "Native runtime ignored the multirotor flight-mode request.");
  }
}

void TestRuntimeConsumesTypedContactObservation() {
  using aerodt::digital_twin::contracts::ContactObservation;
  using aerodt::digital_twin::contracts::VehicleState;
  UamVehicleRuntime runtime(LoadAeroDTAirTaxiRuntimeConfig());
  VehicleState state;
  state.position_ned_m.z = -3.9;
  state.linear_velocity_ned_mps.z = 1.0;
  runtime.Reset(state);

  const ContactObservation contact{
      .has_collided = true,
      .normal_ned = {0.0, 0.0, -1.0},
      .collision_position_ned_m = {0.0, 0.0, -4.0},
      .impact_point_ned_m = {0.0, 0.0, -3.0},
      .penetration_depth_m = 0.02,
  };
  const auto landed = runtime.Advance(ControlAxes{}, contact);
  if (!runtime.IsGrounded() || !landed.state.is_grounded ||
      landed.state.vehicle.time.step != 1) {
    throw std::runtime_error(
        "Runtime did not consume the typed landing observation.");
  }
  Near(landed.state.vehicle.position_ned_m.z, -4.021, 1e-12,
       "runtime landed position");

  const auto held = runtime.Advance(ControlAxes{});
  if (!runtime.IsGrounded() || !held.state.is_grounded ||
      held.state.vehicle.time.step != 2) {
    throw std::runtime_error("Runtime did not retain the ground latch.");
  }
}

}  // namespace

int main() {
  try {
    TestRuntimePreservesPreviousWrenchOrder();
    TestRuntimeMapsPackageActuatorIds();
    TestResetClearsPendingWrench();
    TestPositionGoalRunsControllerInsideNativeTick();
    TestVelocityGoalDrivesNativeTiltrotorTransition();
    TestRuntimeConsumesTypedContactObservation();
    std::cout << "AERODT_NATIVE_UAM_RUNTIME=PASS\n";
    return 0;
  } catch (const std::exception& exception) {
    std::cerr << "AERODT_NATIVE_UAM_RUNTIME=FAIL: " << exception.what() << '\n';
    return 1;
  }
}
