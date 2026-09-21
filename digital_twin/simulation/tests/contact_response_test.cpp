#include <chrono>
#include <cmath>
#include <iostream>
#include <numbers>
#include <stdexcept>

#include "aerodt/digital_twin/simulation/contact/contact_response.hpp"

namespace {

using aerodt::digital_twin::contracts::VehicleState;
using aerodt::digital_twin::contracts::Wrench;
using aerodt::digital_twin::simulation::contact::CalculateCollisionResponse;
using aerodt::digital_twin::simulation::contact::CalculateGroundedState;
using aerodt::digital_twin::contracts::ContactObservation;
using aerodt::digital_twin::simulation::contact::ContactParameters;
using aerodt::digital_twin::simulation::contact::IsLandingCollision;
using aerodt::digital_twin::simulation::contact::NeedsCollisionResponse;
using aerodt::digital_twin::simulation::contact::ShouldRemainGrounded;
using aerodt::foundation::math::Matrix3;
using aerodt::foundation::math::Quaternion;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("Contact parity assertion failed.");
  }
}

ContactObservation GroundContact() {
  return {
      .has_collided = true,
      .normal_ned = {0.0, 0.0, -1.0},
      .collision_position_ned_m = {0.0, 0.0, -10.0},
      .impact_point_ned_m = {0.0, 0.0, -9.0},
  };
}

ContactParameters Parameters() {
  return {
      .restitution = 0.5,
      .friction = 0.5,
  };
}

void TestGroundedStateMatchesProjectAirSimBaseline() {
  VehicleState state;
  const Quaternion roll = Quaternion::FromAxisAngle({1.0, 0.0, 0.0}, std::numbers::pi / 4.0);
  const Quaternion pitch = Quaternion::FromAxisAngle({0.0, 1.0, 0.0}, std::numbers::pi / 4.0);
  const Quaternion yaw = Quaternion::FromAxisAngle({0.0, 0.0, 1.0}, std::numbers::pi / 4.0);
  state.orientation_body_to_ned = (yaw * pitch * roll).Normalized();
  state.linear_velocity_ned_mps = {1.0, 2.0, 3.0};
  const auto grounded = CalculateGroundedState(state, {1.0, 2.0, 3.0});
  Near(grounded.position_ned_m.z, 3.0, 1e-12, "grounded position");
  Near(grounded.linear_velocity_ned_mps.Norm(), 0.0, 1e-12, "grounded velocity");
  Near(grounded.orientation_body_to_ned.z, std::sin(std::numbers::pi / 8.0), 1e-12,
       "grounded yaw");
}

void TestGroundLatchAndLandingClassification() {
  VehicleState state;
  state.linear_velocity_ned_mps.z = 2.0;
  Wrench insufficient_lift;
  insufficient_lift.force_ned_n.z = -10.0;
  if (!ShouldRemainGrounded(true, state, insufficient_lift, {0.0, 0.0, 9.80665}, 2.0)) {
    throw std::runtime_error("Ground latch released below vehicle weight.");
  }
  if (!IsLandingCollision(GroundContact(), state)) {
    throw std::runtime_error("Vertical descent was not classified as landing.");
  }
  if (!NeedsCollisionResponse(GroundContact(), state)) {
    throw std::runtime_error("Motion into the ground did not request collision response.");
  }
}

void TestVerticalBounceMatchesProjectAirSimBaseline() {
  VehicleState state;
  state.position_ned_m = {0.0, 0.0, -9.0};
  state.linear_velocity_ned_mps = {0.0, 0.0, 2.0};
  const auto next = CalculateCollisionResponse(std::chrono::seconds(1), state, GroundContact(),
                                               2.0, Matrix3::Identity(), Parameters());
  Near(next.linear_velocity_ned_mps.z, -1.0, 1e-12, "restitution velocity");
  Near(next.position_ned_m.z, -11.0, 1e-12, "restitution position");
  Near(next.angular_velocity_body_radps.Norm(), 0.0, 1e-12, "restitution angular velocity");
}

void TestTangentialFrictionMatchesProjectAirSimDirection() {
  VehicleState state;
  state.position_ned_m = {0.0, 0.0, -9.0};
  state.linear_velocity_ned_mps = {2.0, 0.0, 0.0};
  const auto next = CalculateCollisionResponse(std::chrono::seconds(1), state, GroundContact(),
                                               2.0, Matrix3::Identity(), Parameters());
  if (!(next.linear_velocity_ned_mps.x < 2.0 && next.linear_velocity_ned_mps.x > 0.0)) {
    throw std::runtime_error("Tangential friction did not slow the vehicle.");
  }
  if (!(next.angular_velocity_body_radps.y < 0.0)) {
    throw std::runtime_error("Tangential friction did not generate pitch response.");
  }
  Near(next.position_ned_m.z, -10.0, 1e-12, "tangential collision position");
}

}  // namespace

int main() {
  TestGroundedStateMatchesProjectAirSimBaseline();
  TestGroundLatchAndLandingClassification();
  TestVerticalBounceMatchesProjectAirSimBaseline();
  TestTangentialFrictionMatchesProjectAirSimDirection();
  std::cout << "AERODT_CONTACT_PARITY=PASS\n";
  return 0;
}
