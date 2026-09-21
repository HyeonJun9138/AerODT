#include <array>
#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>

#include "aerodt/digital_twin/simulation/actuation/control_surface_actuator.hpp"
#include "aerodt/digital_twin/simulation/actuation/rotor_actuator.hpp"
#include "aerodt/digital_twin/simulation/actuation/tilt_actuator.hpp"

namespace {

using namespace aerodt::digital_twin::simulation::actuation;
using aerodt::foundation::math::Quaternion;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("Actuator parity assertion failed.");
  }
}

RotorParameters UamRotor(RotorTurningDirection direction) {
  return {
      .position_body_m = {3.2, -3.2, -0.01},
      .normal_rotor = {0.0, 0.0, -1.0},
      .turning_direction = direction,
      .coefficient_of_thrust = 0.109919,
      .coefficient_of_torque = 0.040164,
      .max_rpm = 6396.667,
      .propeller_diameter_m = 0.6,
      .smoothing_time_constant_s = 0.005,
  };
}

void TestUamRotorConstantsAndFilter() {
  RotorActuator rotor(UamRotor(RotorTurningDirection::clockwise));
  Near(rotor.MaxThrustN(), 198.34389772549753, 1e-9, "maximum thrust");
  Near(rotor.MaxTorqueNm(), 6.920769980073825, 1e-9, "maximum torque");

  const auto output = rotor.Update(0.25, std::chrono::milliseconds(3));
  const double filtered = 0.25 * (1.0 - std::exp(-0.003 / 0.005));
  Near(output.filtered_control, filtered, 1e-12, "filtered rotor control");
  Near(output.thrust_n, filtered * rotor.MaxThrustN(), 1e-9, "filtered thrust");
  if (!(output.reaction_torque_nm > 0.0)) {
    throw std::runtime_error("Clockwise rotor torque sign changed.");
  }
}

void TestTiltRotatesRotorWrench() {
  TiltActuator tilt({
      .angle_min_rad = 0.0,
      .angle_max_rad = 1.57,
      .smoothing_time_constant_s = 0.5,
      .axis = {0.0, -1.0, 0.0},
  });
  const auto tilt_output = tilt.Update(1.0, std::chrono::milliseconds(100));
  Near(tilt_output.filtered_control, 1.0 - std::exp(-0.2), 1e-12, "tilt filter");

  RotorActuator rotor(UamRotor(RotorTurningDirection::counter_clockwise));
  rotor.SetTilt(Quaternion::FromAxisAngle({0.0, -1.0, 0.0}, 3.14159265358979323846 / 2.0));
  const auto output = rotor.Update(1.0, std::chrono::seconds(1));
  Near(output.force_body_n.x, output.thrust_n, 1e-9, "forward tilted thrust");
  Near(output.force_body_n.z, 0.0, 1e-9, "vertical tilted thrust");
  if (!(output.reaction_torque_nm < 0.0)) {
    throw std::runtime_error("Counter-clockwise rotor torque sign changed.");
  }
}

void TestRotorWrenchAggregation() {
  std::array<RotorOutput, 2> outputs{};
  outputs[0].position_body_m = {1.0, 0.0, 0.0};
  outputs[0].force_body_n = {0.0, 0.0, -10.0};
  outputs[1].position_body_m = {-1.0, 0.0, 0.0};
  outputs[1].force_body_n = {0.0, 0.0, -10.0};
  const auto wrench = AggregateRotorWrench(outputs.data(), outputs.size(), Quaternion{});
  Near(wrench.force_ned_n.z, -20.0, 1e-12, "aggregate force");
  Near(wrench.torque_body_nm.y, 0.0, 1e-12, "balanced pitch torque");
}

void TestControlSurfaceFilterAndAngle() {
  ControlSurfaceActuator surface({
      .rotation_rate_rad_per_unit = 0.524,
      .smoothing_time_constant_s = 0.005,
  });
  const auto output = surface.Update(0.5, std::chrono::milliseconds(3));
  const double filtered = 0.5 * (1.0 - std::exp(-0.003 / 0.005));
  Near(output.filtered_control, filtered, 1e-12, "filtered control-surface command");
  Near(output.angle_rad, 0.524 * filtered, 1e-12, "control-surface angle");
}

}  // namespace

int main() {
  TestUamRotorConstantsAndFilter();
  TestTiltRotatesRotorWrench();
  TestRotorWrenchAggregation();
  TestControlSurfaceFilterAndAngle();
  std::cout << "AERODT_ACTUATOR_PARITY=PASS\n";
  return 0;
}
