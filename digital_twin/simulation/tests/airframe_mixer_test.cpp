#include <cmath>
#include <iostream>
#include <stdexcept>

#include "aerodt/digital_twin/simulation/control/simple_flight/airframe.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/multirotor_mixer.hpp"
#include "aerodt/digital_twin/simulation/control/simple_flight/simple_flight_mixer.hpp"

namespace {

using aerodt::digital_twin::simulation::control::simple_flight::Airframe;
using aerodt::digital_twin::simulation::control::simple_flight::ControlAxes;
using aerodt::digital_twin::simulation::control::simple_flight::MixerParameters;
using aerodt::digital_twin::simulation::control::simple_flight::MultirotorMixer;
using aerodt::digital_twin::simulation::control::simple_flight::ParseAirframe;
using aerodt::digital_twin::simulation::control::simple_flight::SimpleFlightMixer;
using aerodt::digital_twin::simulation::control::simple_flight::TiltrotorMixer;
using aerodt::digital_twin::simulation::control::simple_flight::TopologyOf;
using aerodt::digital_twin::simulation::control::simple_flight::ToString;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("Airframe mixer assertion failed.");
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

void TestAirframeNamesAndTopologies() {
  if (ParseAirframe("vtol-quad-tiltrotor") != Airframe::vtol_quad_tiltrotor ||
      ParseAirframe("quadrotor-x") != Airframe::quadrotor_x ||
      ParseAirframe("hexarotor-x") != Airframe::hexarotor_x ||
      ParseAirframe("vtol-quad-x-tailsitter").has_value()) {
    throw std::runtime_error("Airframe names are not the package spellings.");
  }
  for (const auto airframe : {Airframe::vtol_quad_tiltrotor, Airframe::quadrotor_x, Airframe::hexarotor_x}) {
    if (ParseAirframe(ToString(airframe)) != airframe) {
      throw std::runtime_error("Airframe name does not round-trip.");
    }
  }
  const auto tiltrotor = TopologyOf(Airframe::vtol_quad_tiltrotor);
  const auto quad = TopologyOf(Airframe::quadrotor_x);
  const auto hex = TopologyOf(Airframe::hexarotor_x);
  if (tiltrotor.rotor_count != 4 || tiltrotor.tilt_count != 4 || !tiltrotor.lifting_surfaces_allowed ||
      !tiltrotor.fixed_wing_capable) {
    throw std::runtime_error("Tiltrotor topology is wrong.");
  }
  if (quad.rotor_count != 4 || quad.tilt_count != 0 || quad.lifting_surfaces_allowed || quad.fixed_wing_capable) {
    throw std::runtime_error("Quadrotor topology is wrong.");
  }
  if (hex.rotor_count != 6 || hex.tilt_count != 0 || hex.lifting_surfaces_allowed || hex.fixed_wing_capable) {
    throw std::runtime_error("Hexarotor topology is wrong.");
  }
}

// ProjectAirSim Mixer.hpp QuadX: roll to the right lowers the right rotors
// (front right and rear right) and raises the left ones by the same amount.
void TestQuadXMatchesLegacyMatrix() {
  MultirotorMixer mixer(Airframe::quadrotor_x, {.actuator_count = 4, .rotor_count = 4});
  const auto hover = mixer.Mix({.throttle = 0.5});
  for (const auto output : hover) Near(output, 0.5, 1e-12, "hover spreads throttle evenly");

  const auto roll = mixer.Mix({.roll = 0.1, .throttle = 0.5});
  Near(roll[0], 0.4, 1e-12, "front right drops on right roll");
  Near(roll[1], 0.6, 1e-12, "rear left rises on right roll");
  Near(roll[2], 0.6, 1e-12, "front left rises on right roll");
  Near(roll[3], 0.4, 1e-12, "rear right drops on right roll");

  const auto pitch = mixer.Mix({.pitch = 0.1, .throttle = 0.5});
  Near(pitch[0], 0.6, 1e-12, "front right rises on pitch");
  Near(pitch[1], 0.4, 1e-12, "rear left drops on pitch");
  Near(pitch[2], 0.6, 1e-12, "front left rises on pitch");
  Near(pitch[3], 0.4, 1e-12, "rear right drops on pitch");

  const auto yaw = mixer.Mix({.yaw = 0.1, .throttle = 0.5});
  Near(yaw[0], 0.6, 1e-12, "counter-clockwise rotors speed up on yaw");
  Near(yaw[1], 0.6, 1e-12, "counter-clockwise rotors speed up on yaw");
  Near(yaw[2], 0.4, 1e-12, "clockwise rotors slow on yaw");
  Near(yaw[3], 0.4, 1e-12, "clockwise rotors slow on yaw");

  const auto tilted = mixer.Mix({.throttle = 0.5, .tilt = 1.0});
  for (const auto output : tilted) Near(output, 0.5, 1e-12, "a multirotor ignores the tilt axis");
}

void TestHexXMatchesLegacyMatrix() {
  MultirotorMixer mixer(Airframe::hexarotor_x, {.actuator_count = 6, .rotor_count = 6});
  const auto hover = mixer.Mix({.throttle = 0.5});
  if (hover.size() != 6) throw std::runtime_error("Hexarotor mixes six rotors.");
  for (const auto output : hover) Near(output, 0.5, 1e-12, "hex hover is even");
  const auto roll = mixer.Mix({.roll = 0.1, .throttle = 0.5});
  const double expected_roll[] = {0.55, 0.45, 0.4, 0.45, 0.55, 0.6};
  for (int index = 0; index < 6; ++index) Near(roll[index], expected_roll[index], 1e-12, "hex roll row");
  const auto pitch = mixer.Mix({.pitch = 0.1, .throttle = 0.5});
  const double expected_pitch[] = {0.6, 0.6, 0.5, 0.4, 0.4, 0.5};
  for (int index = 0; index < 6; ++index) Near(pitch[index], expected_pitch[index], 1e-12, "hex pitch row");
  const auto yaw = mixer.Mix({.yaw = 0.1, .throttle = 0.5});
  const double expected_yaw[] = {0.4, 0.6, 0.4, 0.6, 0.4, 0.6};
  for (int index = 0; index < 6; ++index) Near(yaw[index], expected_yaw[index], 1e-12, "hex yaw row");
}

// The rotor bounds behave as the tiltrotor mixer's do: lifted together on
// undershoot, scaled together on overshoot, so command ratios survive.
void TestMultirotorSaturationKeepsRatios() {
  MultirotorMixer mixer(Airframe::quadrotor_x, {.actuator_count = 4, .rotor_count = 4,
                                                .minimum_rotor_output = 0.0, .maximum_rotor_output = 1.0});
  const auto low = mixer.Mix({.roll = 0.5, .throttle = 0.1});
  Near(low[0], 0.0, 1e-12, "undershooting rotor is lifted to the minimum");
  Near(low[1], 1.0, 1e-12, "the others lift by the same offset");
  const auto high = mixer.Mix({.pitch = 0.5, .throttle = 1.5});
  Near(high[0], 1.0, 1e-12, "overshooting rotor is scaled to the maximum");
  Near(high[1] / high[0], 1.0 / 2.0, 1e-12, "scaling keeps the commanded ratio");
}

void TestSimpleFlightMixerSelectsByAirframe() {
  SimpleFlightMixer tiltrotor(Airframe::vtol_quad_tiltrotor, {.actuator_count = 11, .rotor_count = 4});
  TiltrotorMixer reference({.actuator_count = 11, .rotor_count = 4});
  const ControlAxes controls{.roll = 0.1, .pitch = -0.05, .yaw = 0.02, .throttle = 0.6, .tilt = 0.3};
  const auto chosen = tiltrotor.Mix(controls), expected = reference.Mix(controls);
  if (chosen.size() != expected.size()) throw std::runtime_error("Tiltrotor path lost outputs.");
  for (std::size_t index = 0; index < chosen.size(); ++index) {
    Near(chosen[index], expected[index], 1e-15, "tiltrotor selection is the tiltrotor mixer");
  }
  SimpleFlightMixer quad(Airframe::quadrotor_x, {.actuator_count = 4, .rotor_count = 4});
  const auto quad_out = quad.Mix({.throttle = 0.5, .tilt = 1.0});
  if (quad_out.size() != 4) throw std::runtime_error("Quadrotor selection mixes four rotors.");
  for (const auto output : quad_out) Near(output, 0.5, 1e-12, "quadrotor selection is the QuadX mixer");
  if (quad.AirframeKind() != Airframe::quadrotor_x) throw std::runtime_error("Mixer forgot its airframe.");
}

void TestMultirotorMixerRejectsWrongTopology() {
  Throws([] { MultirotorMixer(Airframe::vtol_quad_tiltrotor, {.actuator_count = 11, .rotor_count = 4}); },
         "a tiltrotor is not a multirotor mixer");
  Throws([] { MultirotorMixer(Airframe::quadrotor_x, {.actuator_count = 6, .rotor_count = 6}); },
         "a quadrotor mixer needs four rotors");
  Throws([] { MultirotorMixer(Airframe::hexarotor_x, {.actuator_count = 4, .rotor_count = 4}); },
         "a hexarotor mixer needs six rotors");
  Throws([] { MultirotorMixer(Airframe::quadrotor_x, {.actuator_count = 3, .rotor_count = 4}); },
         "actuators cannot be fewer than rotors");
  MultirotorMixer mixer(Airframe::quadrotor_x, {.actuator_count = 4, .rotor_count = 4});
  Throws([&mixer] { (void)mixer.Mix({.throttle = std::nan("")}); }, "controls must be finite");
}

}  // namespace

int main() {
  try {
    TestAirframeNamesAndTopologies();
    TestQuadXMatchesLegacyMatrix();
    TestHexXMatchesLegacyMatrix();
    TestMultirotorSaturationKeepsRatios();
    TestSimpleFlightMixerSelectsByAirframe();
    TestMultirotorMixerRejectsWrongTopology();
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
  std::cout << "AERODT_AIRFRAME_MIXER=PASS\n";
  return 0;
}
