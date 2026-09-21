#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>

#include "aerodt/digital_twin/simulation/fast_physics/fast_physics_engine.hpp"

namespace {

using aerodt::digital_twin::contracts::VehicleState;
using aerodt::digital_twin::contracts::Wrench;
using aerodt::digital_twin::contracts::ContactObservation;
using aerodt::digital_twin::simulation::contact::ContactParameters;
using aerodt::digital_twin::simulation::fast_physics::FastPhysicsEngine;
using aerodt::digital_twin::simulation::fast_physics::FastPhysicsParameters;
using aerodt::digital_twin::simulation::aerodynamics::DragFace;
using aerodt::foundation::math::Matrix3;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("FastPhysics parity assertion failed.");
  }
}

FastPhysicsEngine MakeEngine() {
  return FastPhysicsEngine({
      .mass_kg = 2.0,
      .inertia_body_kg_m2 = Matrix3::Identity(),
      .gravity_ned_mps2 = {0.0, 0.0, 9.80665},
  });
}

void TestGravityMatchesProjectAirSimBaseline() {
  auto engine = MakeEngine();
  VehicleState initial;
  initial.position_ned_m.z = -10.0;
  engine.Reset(initial);

  const auto& first = engine.Advance(std::chrono::seconds(1), Wrench{});
  Near(first.position_ned_m.z, -10.0, 1e-9, "first position z");
  Near(first.linear_velocity_ned_mps.z, 4.903325, 1e-9, "first velocity z");
  Near(first.linear_acceleration_ned_mps2.z, 9.80665, 1e-9, "first acceleration z");

  const auto& second = engine.Advance(std::chrono::seconds(1), Wrench{});
  Near(second.position_ned_m.z, -0.19335, 1e-6, "second position z");
  Near(second.linear_velocity_ned_mps.z, 14.709975, 1e-6, "second velocity z");
}

void TestHoverAndLateralForceMatchProjectAirSimBaseline() {
  auto engine = MakeEngine();
  VehicleState initial;
  initial.position_ned_m.z = -10.0;
  engine.Reset(initial);

  Wrench hover;
  hover.force_ned_n.z = -2.0 * 9.80665;
  const auto& stationary = engine.Advance(std::chrono::seconds(1), hover);
  Near(stationary.position_ned_m.z, -10.0, 1e-9, "hover position z");
  Near(stationary.linear_velocity_ned_mps.z, 0.0, 1e-9, "hover velocity z");

  engine.Reset(initial);
  hover.force_ned_n.x = 10.0;
  const auto& lateral = engine.Advance(std::chrono::seconds(1), hover);
  Near(lateral.position_ned_m.x, 0.0, 1e-9, "first lateral position x");
  Near(lateral.linear_velocity_ned_mps.x, 2.5, 1e-9, "first lateral velocity x");
  const auto& lateral_second = engine.Advance(std::chrono::seconds(1), hover);
  Near(lateral_second.position_ned_m.x, 5.0, 1e-9, "second lateral position x");
  Near(lateral_second.linear_velocity_ned_mps.x, 7.5, 1e-9, "second lateral velocity x");
}

void TestInvalidParametersAreRejected() {
  bool rejected = false;
  try {
    FastPhysicsEngine invalid({.mass_kg = 0.0});
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  if (!rejected) throw std::runtime_error("Zero mass was accepted.");
}

void TestConfiguredAerodynamicsParticipateInPhysicsStep() {
  FastPhysicsParameters parameters{
      .mass_kg = 2.0,
      .inertia_body_kg_m2 = Matrix3::Identity(),
      .gravity_ned_mps2 = {},
      .aerodynamic_environment = {.air_density_kgpm3 = 1.0},
      .drag_faces = {
          DragFace{.outward_normal_body = {1.0, 0.0, 0.0},
                   .area_m2 = 2.0,
                   .drag_factor = 0.5},
      },
  };
  FastPhysicsEngine engine(parameters);
  VehicleState initial;
  initial.linear_velocity_ned_mps.x = 2.0;
  engine.Reset(initial);

  const auto& next = engine.Advance(std::chrono::seconds(1), {});
  Near(next.linear_acceleration_ned_mps2.x, -2.0, 1e-12, "drag acceleration x");
  Near(next.linear_velocity_ned_mps.x, 1.0, 1e-12, "drag velocity x");
}

void TestContactObservationSelectsLandingAndGroundLatchBranches() {
  auto engine = MakeEngine();
  VehicleState initial;
  initial.position_ned_m.z = -9.0;
  initial.linear_velocity_ned_mps.z = 2.0;
  engine.Reset(initial);
  const ContactObservation ground{
      .has_collided = true,
      .normal_ned = {0.0, 0.0, -1.0},
      .collision_position_ned_m = {0.0, 0.0, -10.0},
      .impact_point_ned_m = {0.0, 0.0, -9.0},
  };
  const ContactParameters contact{
      .restitution = 0.5,
      .friction = 0.5,
  };

  const auto& landed = engine.Advance(
      std::chrono::seconds(1), Wrench{}, ground, contact);
  if (!engine.IsGrounded() || landed.time.step != 1) {
    throw std::runtime_error("Landing collision did not latch grounded state.");
  }
  Near(landed.position_ned_m.z, -10.001, 1e-12,
       "landing collision clearance");
  Near(landed.linear_velocity_ned_mps.Norm(), 0.0, 1e-12,
       "landing grounded velocity");

  const auto& held = engine.Advance(
      std::chrono::seconds(1), Wrench{}, ContactObservation{}, contact);
  if (!engine.IsGrounded() || held.time.step != 2) {
    throw std::runtime_error("Insufficient lift released the ground latch.");
  }
  Near(held.position_ned_m.z, -10.001, 1e-12,
       "ground latch position");

  Wrench takeoff;
  takeoff.force_ned_n.z = -25.0;
  const auto& released = engine.Advance(
      std::chrono::seconds(1), takeoff, ContactObservation{}, contact);
  if (engine.IsGrounded() || released.time.step != 3) {
    throw std::runtime_error("Lift above weight did not release ground latch.");
  }
}

void TestContactObservationSelectsImpulseBranch() {
  auto engine = MakeEngine();
  VehicleState initial;
  initial.linear_velocity_ned_mps.x = 2.0;
  engine.Reset(initial);
  const ContactObservation wall{
      .has_collided = true,
      .normal_ned = {-1.0, 0.0, 0.0},
      .collision_position_ned_m = {1.0, 0.0, 0.0},
      .impact_point_ned_m = {1.0, 0.0, 0.0},
  };
  const auto& bounced = engine.Advance(
      std::chrono::seconds(1), Wrench{}, wall,
      ContactParameters{.restitution = 0.5, .friction = 0.0});
  if (engine.IsGrounded()) {
    throw std::runtime_error("Wall collision was misclassified as landing.");
  }
  Near(bounced.linear_velocity_ned_mps.x, -1.0, 1e-12,
       "integrated collision restitution velocity");
  if (bounced.time.step != 1) {
    throw std::runtime_error("Collision response advanced simulation time incorrectly.");
  }
}

}  // namespace

int main() {
  TestGravityMatchesProjectAirSimBaseline();
  TestHoverAndLateralForceMatchProjectAirSimBaseline();
  TestInvalidParametersAreRejected();
  TestConfiguredAerodynamicsParticipateInPhysicsStep();
  TestContactObservationSelectsLandingAndGroundLatchBranches();
  TestContactObservationSelectsImpulseBranch();
  std::cout << "AERODT_FAST_PHYSICS_PARITY=PASS\n";
  return 0;
}
