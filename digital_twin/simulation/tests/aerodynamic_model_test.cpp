#include <cmath>
#include <iostream>
#include <stdexcept>
#include <vector>

#include "aerodt/digital_twin/simulation/aerodynamics/aerodynamic_model.hpp"

namespace {

using aerodt::digital_twin::simulation::aerodynamics::AerodynamicEnvironment;
using aerodt::digital_twin::simulation::aerodynamics::CalculateDragFaceWrench;
using aerodt::digital_twin::simulation::aerodynamics::CalculateLiftDragWrench;
using aerodt::digital_twin::simulation::aerodynamics::DragFace;
using aerodt::digital_twin::simulation::aerodynamics::LiftingSurface;
using aerodt::foundation::math::Quaternion;
using aerodt::foundation::math::Vector3;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("Aerodynamic parity assertion failed.");
  }
}

std::vector<DragFace> ProjectAirSimDragFixture() {
  return {
      {.outward_normal_body = {0.0, 0.0, 1.0}, .area_m2 = 2.0, .drag_factor = 0.5},
      {.outward_normal_body = {0.0, 0.0, -1.0}, .area_m2 = 3.0, .drag_factor = 0.5},
  };
}

void TestDragMatchesProjectAirSimBaseline() {
  const auto faces = ProjectAirSimDragFixture();
  const AerodynamicEnvironment environment{.air_density_kgpm3 = 1.0};

  auto wrench = CalculateDragFaceWrench({0.0, 0.0, 2.0}, faces, {}, environment);
  Near(wrench.force_ned_n.z, -4.0, 1e-12, "positive-z drag");
  Near(wrench.torque_body_nm.Norm(), 0.0, 1e-12, "drag torque");

  wrench = CalculateDragFaceWrench({0.0, 0.0, -2.0}, faces, {}, environment);
  Near(wrench.force_ned_n.z, 6.0, 1e-12, "negative-z drag");

  wrench = CalculateDragFaceWrench({1.0, 1.0, 0.0}, faces, {}, environment);
  Near(wrench.force_ned_n.Norm(), 0.0, 1e-12, "perpendicular drag");

  constexpr double kHalfPi = 1.57079632679489661923;
  const Quaternion pitch_90 = Quaternion::FromAxisAngle({0.0, 1.0, 0.0}, kHalfPi);
  wrench = CalculateDragFaceWrench({0.0, 0.0, 1.0}, faces, pitch_90, environment);
  Near(wrench.force_ned_n.Norm(), 0.0, 1e-12, "rotated face drag");
}

void TestWindUsesRelativeAirspeed() {
  const auto faces = ProjectAirSimDragFixture();
  const AerodynamicEnvironment environment{
      .air_density_kgpm3 = 1.0,
      .wind_velocity_ned_mps = {0.0, 0.0, 3.0},
  };
  const auto wrench = CalculateDragFaceWrench({0.0, 0.0, 1.0}, faces, {}, environment);
  Near(wrench.force_ned_n.z, 6.0, 1e-12, "headwind drag");
}

LiftingSurface AirTaxiLeftWing() {
  LiftingSurface wing;
  wing.origin_body_m = {0.0, -1.0, 0.0};
  wing.parameters.alpha_zero_rad = 0.06;
  wing.parameters.alpha_stall_rad = 0.64;
  wing.parameters.lift_slope_per_rad = 0.5;
  wing.parameters.lift_stall_slope_per_rad = -0.8;
  wing.parameters.drag_slope_per_rad = 0.6;
  wing.parameters.drag_stall_slope_per_rad = -0.9;
  wing.parameters.area_m2 = 5.0;
  wing.parameters.control_lift_per_rad = -0.5;
  wing.parameters.control_moment_per_rad = -0.1;
  return wing;
}

void TestAirTaxiWingAtZeroGeometricAngle() {
  const LiftingSurface wing = AirTaxiLeftWing();
  const AerodynamicEnvironment environment{.air_density_kgpm3 = 1.0};
  const auto wrench = CalculateLiftDragWrench({wing}, {}, {10.0, 0.0, 0.0}, environment);

  // q = 50 Pa, alpha = 0.06 rad, Cl = 0.03, Cd = 0.036, area = 5 m^2.
  Near(wrench.force_ned_n.x, -9.0, 1e-10, "wing drag x");
  Near(wrench.force_ned_n.z, -7.5, 1e-10, "wing lift z");
  Near(wrench.torque_body_nm.x, 7.5, 1e-10, "wing roll moment");
}

void TestControlSurfaceChangesLiftAndPitchMoment() {
  LiftingSurface wing = AirTaxiLeftWing();
  wing.control_angle_rad = 0.1;
  const AerodynamicEnvironment environment{.air_density_kgpm3 = 1.0};
  const auto wrench = CalculateLiftDragWrench({wing}, {}, {10.0, 0.0, 0.0}, environment);

  // Cl becomes -0.02 and Cm becomes -0.01 at the package's configured gains.
  Near(wrench.force_ned_n.z, 5.0, 1e-10, "controlled wing lift z");
  Near(wrench.torque_body_nm.y, -2.5, 1e-10, "controlled wing pitch moment");
}

void TestInvalidSurfaceIsRejected() {
  LiftingSurface invalid = AirTaxiLeftWing();
  invalid.parameters.area_m2 = -1.0;
  bool rejected = false;
  try {
    static_cast<void>(CalculateLiftDragWrench({invalid}, {}, {10.0, 0.0, 0.0}, {}));
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  if (!rejected) throw std::runtime_error("Negative lifting-surface area was accepted.");
}

}  // namespace

int main() {
  TestDragMatchesProjectAirSimBaseline();
  TestWindUsesRelativeAirspeed();
  TestAirTaxiWingAtZeroGeometricAngle();
  TestControlSurfaceChangesLiftAndPitchMoment();
  TestInvalidSurfaceIsRejected();
  std::cout << "AERODT_AERODYNAMICS_PARITY=PASS\n";
  return 0;
}
