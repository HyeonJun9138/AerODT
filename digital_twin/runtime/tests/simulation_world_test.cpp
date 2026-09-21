#include <chrono>
#include <cmath>
#include <iostream>
#include <memory>
#include <stdexcept>

#include "aerodt/digital_twin/runtime/simulation_world.hpp"
#include "aerodt/digital_twin/simulation/environment/flat_ground_contact_model.hpp"

namespace {

using aerodt::digital_twin::contracts::ContactObservation;
using aerodt::digital_twin::runtime::LoadAeroDTAirTaxiRuntimeConfig;
using aerodt::digital_twin::runtime::LoadAeroDTQuadrotorRuntimeConfig;
using aerodt::digital_twin::runtime::SimulationClock;
using aerodt::digital_twin::runtime::SimulationWorld;
using aerodt::digital_twin::runtime::TrajectoryActorRuntime;
using aerodt::digital_twin::runtime::UamVehicleRuntime;
using aerodt::digital_twin::simulation::control::simple_flight::Airframe;
using aerodt::digital_twin::simulation::control::simple_flight::PositionYawRateGoalNed;
using aerodt::digital_twin::simulation::control::simple_flight::VelocityYawAngleGoalNed;
using aerodt::digital_twin::simulation::environment::FlatGroundContactModel;
using aerodt::digital_twin::simulation::trajectory::KinematicTrajectory;
using aerodt::digital_twin::simulation::trajectory::TrajectorySample;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("Simulation world assertion failed.");
  }
}

template <typename Action>
void Throws(Action action, const char* label) {
  try {
    action();
  } catch (const std::invalid_argument&) {
    return;
  }
  std::cerr << label << '\n';
  throw std::runtime_error("Expected an invalid_argument.");
}

void TestQuadrotorPackageCompilesToAMultirotorAirframe() {
  const auto config = LoadAeroDTQuadrotorRuntimeConfig();
  if (config.package_id != "aerodt.vehicle.air.multirotor.quadrotor" || config.entity_id != "QUAD1" ||
      config.airframe != Airframe::quadrotor_x || config.airframe_id != "quadrotor-x") {
    throw std::runtime_error("Quadrotor package identity was not compiled.");
  }
  if (config.rotors.size() != 4 || !config.tilts.empty() || !config.lifting_surfaces.empty() ||
      config.actuator_order.size() != 4 || config.mixer.rotor_count != 4 ||
      config.simple_flight.fixed_wing_capable) {
    throw std::runtime_error("Quadrotor topology was not compiled as a plain multirotor.");
  }
  Near(config.fast_physics.mass_kg, 1.0, 1e-12, "frame mass");
  if (config.sensors.imu.size() != 1 || config.sensors.gps.size() != 1 || !config.sensors.cameras.empty()) {
    throw std::runtime_error("Quadrotor sensors were not compiled.");
  }
  const auto airtaxi = LoadAeroDTAirTaxiRuntimeConfig();
  if (airtaxi.airframe != Airframe::vtol_quad_tiltrotor) {
    throw std::runtime_error("AirTaxi package lost its airframe.");
  }
}

// The 1 kg demonstration quadrotor climbs to a position goal on the QuadX
// mixer alone: no tilts, no wings, the plain multirotor cascade.
void TestQuadrotorClimbsToAPositionGoal() {
  UamVehicleRuntime quad(LoadAeroDTQuadrotorRuntimeConfig());
  FlatGroundContactModel ground({.ground_plane_down_m = 0.0,
                                 .body_ground_clearance_m = quad.Config().body_ground_clearance_m});
  const PositionYawRateGoalNed goal{.position_ned_m = {0.0, 0.0, -5.0}, .yaw_rate_body_radps = 0.0};
  ContactObservation contact;
  const int steps = static_cast<int>(8.0 / std::chrono::duration<double>(quad.Config().step).count());
  for (int index = 0; index < steps; ++index) {
    const auto tick = quad.AdvancePositionGoal(goal, contact);
    contact = ground.Observe(tick.state.vehicle);
    if (tick.actuator_commands.size() != 4 || !tick.tilts.empty() || !tick.control_surfaces.empty()) {
      throw std::runtime_error("Quadrotor tick drove actuators it does not have.");
    }
  }
  const auto& state = quad.State();
  if (!(state.position_ned_m.z < -3.0) || !(state.position_ned_m.z > -7.0)) {
    std::cerr << "quadrotor altitude after 8 s: " << state.position_ned_m.z << '\n';
    throw std::runtime_error("Quadrotor did not climb toward its goal.");
  }
  Near(state.position_ned_m.x, 0.0, 0.5, "quadrotor holds north");
  Near(state.position_ned_m.y, 0.0, 0.5, "quadrotor holds east");
  if (quad.IsGrounded()) throw std::runtime_error("Quadrotor is still on the ground.");
}

// A multirotor cannot honour a fixed-wing request: the tick runs, the blend stays multirotor.
void TestMultirotorIgnoresFixedWingRequest() {
  UamVehicleRuntime quad(LoadAeroDTQuadrotorRuntimeConfig());
  const VelocityYawAngleGoalNed goal{.velocity_ned_mps = {5.0, 0.0, -1.0}, .yaw_angle_ned_rad = 0.0};
  for (int index = 0; index < 400; ++index) {
    const auto tick = quad.AdvanceVelocityGoal(goal, true);
    if (tick.transition.fixed_wing_blend != 0.0) {
      throw std::runtime_error("A multirotor airframe started a fixed-wing transition.");
    }
  }
}

void TestWorldAdvancesEveryEntityOnOneClock() {
  const auto step = std::chrono::nanoseconds(3000000);
  SimulationWorld world(step);
  auto quad = std::make_unique<UamVehicleRuntime>(LoadAeroDTQuadrotorRuntimeConfig());
  const PositionYawRateGoalNed goal{.position_ned_m = {0.0, 0.0, -5.0}, .yaw_rate_body_radps = 0.0};
  FlatGroundContactModel ground({.ground_plane_down_m = 0.0, .body_ground_clearance_m = quad->Config().body_ground_clearance_m});
  auto contact = std::make_shared<ContactObservation>();
  world.AddVehicle(std::move(quad), [goal, ground, contact](UamVehicleRuntime& vehicle) {
    auto tick = vehicle.AdvancePositionGoal(goal, *contact);
    *contact = ground.Observe(tick.state.vehicle);
    return tick;
  });
  world.AddTrajectoryActor(TrajectoryActorRuntime(
      "FPL1412001", KinematicTrajectory({
          {.time_s = 0.0, .position_ned_m = {0.0, 500.0, 0.0}},
          {.time_s = 10.0, .position_ned_m = {1000.0, 500.0, -300.0}, .velocity_ned_mps = {100.0, 0.0, -30.0}},
      })));
  if (world.EntityCount() != 2 || world.Snapshots().size() != 2) {
    throw std::runtime_error("World does not hold both entities.");
  }
  if (world.Snapshots()[0].entity_id != "QUAD1" || world.Snapshots()[1].entity_id != "FPL1412001") {
    throw std::runtime_error("Snapshot order is not vehicles then actors.");
  }
  Near(world.Snapshots()[1].vehicle.position_ned_m.y, 500.0, 1e-12, "actor starts at its first row");

  const int steps = static_cast<int>(5.0 / std::chrono::duration<double>(step).count());
  for (int index = 0; index < steps; ++index) world.Advance();
  const auto& snapshots = world.Snapshots();
  if (world.Clock().Now().step != static_cast<std::uint64_t>(steps)) {
    throw std::runtime_error("Clock did not count every step.");
  }
  if (snapshots[0].vehicle.time.step != snapshots[1].vehicle.time.step ||
      snapshots[0].vehicle.time.step != world.Clock().Now().step) {
    throw std::runtime_error("Entities are not in lockstep with the clock.");
  }
  // 1666 steps of 3 ms is 4.998 s: the actor is exactly where the clock says.
  const double seconds = std::chrono::duration<double>(world.Clock().Now().elapsed).count();
  Near(snapshots[1].vehicle.position_ned_m.x, 100.0 * seconds, 1e-6, "actor is where its table says at the clock time");
  Near(snapshots[1].vehicle.position_ned_m.z, -30.0 * seconds, 1e-6, "actor climbed as its table says");
  if (!(snapshots[0].vehicle.position_ned_m.z < -1.0)) {
    throw std::runtime_error("Vehicle did not fly inside the world.");
  }
  if (world.LastVehicleTick(0).state.entity_id != "QUAD1") {
    throw std::runtime_error("The last vehicle tick is not kept.");
  }

  world.Reset();
  if (world.Clock().Now().step != 0 || world.Snapshots()[0].vehicle.time.step != 0) {
    throw std::runtime_error("Reset did not return the world to time zero.");
  }
  Near(world.Snapshots()[1].vehicle.position_ned_m.x, 0.0, 1e-12, "actor reset to its first row");
}

void TestWorldRejectsMismatchedOrDuplicateEntities() {
  Throws([] { SimulationClock(std::chrono::nanoseconds(0)); }, "zero step");
  SimulationWorld world(std::chrono::nanoseconds(1000000));
  Throws([&world] {
    world.AddVehicle(std::make_unique<UamVehicleRuntime>(LoadAeroDTQuadrotorRuntimeConfig()),
                     [](UamVehicleRuntime& v) { return v.Advance({}); });
  }, "a vehicle on a different step");
  SimulationWorld same(std::chrono::nanoseconds(3000000));
  same.AddTrajectoryActor(TrajectoryActorRuntime("A", KinematicTrajectory({{.time_s = 0.0}})));
  Throws([&same] { same.AddTrajectoryActor(TrajectoryActorRuntime("A", KinematicTrajectory({{.time_s = 0.0}}))); },
         "duplicate entity ID");
  Throws([] { TrajectoryActorRuntime("", KinematicTrajectory({{.time_s = 0.0}})); }, "empty entity ID");
  Throws([&same] { same.AddVehicle(nullptr, [](UamVehicleRuntime& v) { return v.Advance({}); }); }, "missing vehicle");
}

}  // namespace

int main() {
  try {
    TestQuadrotorPackageCompilesToAMultirotorAirframe();
    TestQuadrotorClimbsToAPositionGoal();
    TestMultirotorIgnoresFixedWingRequest();
    TestWorldAdvancesEveryEntityOnOneClock();
    TestWorldRejectsMismatchedOrDuplicateEntities();
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
  std::cout << "AERODT_SIMULATION_WORLD=PASS\n";
  return 0;
}
