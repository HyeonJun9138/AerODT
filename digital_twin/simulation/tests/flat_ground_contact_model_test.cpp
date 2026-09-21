#include "aerodt/digital_twin/simulation/environment/flat_ground_contact_model.hpp"

#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {

using aerodt::digital_twin::contracts::VehicleState;
using aerodt::digital_twin::simulation::environment::FlatGroundContactModel;
using aerodt::digital_twin::simulation::environment::FlatGroundParameters;

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void Near(double actual, double expected, double tolerance, const char* message) {
  if (std::abs(actual - expected) > tolerance) {
    throw std::runtime_error(message);
  }
}

void TestClearanceAndPenetration() {
  FlatGroundContactModel ground({
      .ground_plane_down_m = 0.0,
      .body_ground_clearance_m = 1.34,
  });
  VehicleState state;
  state.position_ned_m = {2.0, -3.0, -1.5};
  Require(!ground.Observe(state).has_collided,
          "vehicle above the plane reported contact");

  state.position_ned_m.z = -1.30;
  const auto contact = ground.Observe(state);
  Require(contact.has_collided, "penetrating vehicle did not report contact");
  Near(contact.normal_ned.z, -1.0, 1e-12, "ground normal is not NED up");
  Near(contact.impact_point_ned_m.x, 2.0, 1e-12, "impact north changed");
  Near(contact.impact_point_ned_m.y, -3.0, 1e-12, "impact east changed");
  Near(contact.impact_point_ned_m.z, 0.0, 1e-12, "impact is not on plane");
  Near(contact.penetration_depth_m, 0.04, 1e-12,
       "penetration depth is incorrect");
}

void TestInvalidInputsAreRejected() {
  bool threw = false;
  try {
    FlatGroundContactModel invalid({});
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  Require(threw, "zero body clearance was accepted");

  FlatGroundContactModel ground({.body_ground_clearance_m = 1.0});
  VehicleState invalid_state;
  invalid_state.position_ned_m.x = std::numeric_limits<double>::quiet_NaN();
  threw = false;
  try {
    static_cast<void>(ground.Observe(invalid_state));
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  Require(threw, "non-finite vehicle state was accepted");
}

}  // namespace

int main() {
  try {
    TestClearanceAndPenetration();
    TestInvalidInputsAreRejected();
    std::cout << "AERODT_FLAT_GROUND_CONTACT_TEST=PASS\n";
    return 0;
  } catch (const std::exception& exception) {
    std::cerr << "AERODT_FLAT_GROUND_CONTACT_TEST=FAIL: " << exception.what()
              << '\n';
    return 1;
  }
}
