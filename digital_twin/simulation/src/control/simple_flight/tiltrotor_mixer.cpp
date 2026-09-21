#include "aerodt/digital_twin/simulation/control/simple_flight/tiltrotor_mixer.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::control::simple_flight {

const TiltrotorMixer::MixerMatrix TiltrotorMixer::kMultirotorMatrix{{
    {-0.5, 0.5, 0.5, 1.0, 0.0},
    {0.5, -0.5, 0.5, 1.0, 0.0},
    {0.5, 0.5, -0.5, 1.0, 0.0},
    {-0.5, -0.5, -0.5, 1.0, 0.0},
    {0.0, 0.0, 0.2, 0.0, 1.0},
    {0.0, 0.0, 0.2, 0.0, 1.0},
    {0.0, 0.0, -0.2, 0.0, 1.0},
    {0.0, 0.0, -0.2, 0.0, 1.0},
    {0.0, 0.0, 0.0, 0.0, 0.0},
    {0.0, 0.0, 0.0, 0.0, 0.0},
    {0.0, 1.0, 0.0, 0.0, 0.0},
    {0.0, 0.0, 0.0, 0.0, 0.0},
}};

const TiltrotorMixer::MixerMatrix TiltrotorMixer::kFixedWingMatrix{{
    {0.0, 0.0, -0.5, 1.0, 0.0},
    {0.0, 0.0, 0.5, 1.0, 0.0},
    {0.0, 0.0, 0.5, 1.0, 0.0},
    {0.0, 0.0, -0.5, 1.0, 0.0},
    {0.0, 0.0, 0.0, 0.0, 1.0},
    {0.0, 0.0, 0.0, 0.0, 1.0},
    {0.0, 0.0, 0.0, 0.0, 1.0},
    {0.0, 0.0, 0.0, 0.0, 1.0},
    {-1.0, 0.0, 0.0, 0.0, 0.0},
    {1.0, 0.0, 0.0, 0.0, 0.0},
    {0.0, 1.0, 0.0, 0.0, 0.0},
    {0.0, 0.0, -1.0, 0.0, 0.0},
}};

TiltrotorMixer::TiltrotorMixer(MixerParameters parameters) : parameters_(parameters) {
  if (parameters_.actuator_count == 0 || parameters_.actuator_count > kMultirotorMatrix.size() ||
      parameters_.rotor_count == 0 || parameters_.rotor_count > parameters_.actuator_count ||
      !std::isfinite(parameters_.minimum_rotor_output) ||
      !std::isfinite(parameters_.maximum_rotor_output) ||
      parameters_.maximum_rotor_output <= 0.0 ||
      parameters_.minimum_rotor_output > parameters_.maximum_rotor_output ||
      !std::isfinite(parameters_.minimum_control_output) ||
      !std::isfinite(parameters_.maximum_control_output) ||
      parameters_.minimum_control_output > parameters_.maximum_control_output) {
    throw std::invalid_argument("SimpleFlight tiltrotor mixer parameters are invalid.");
  }
}

std::vector<double> TiltrotorMixer::Mix(const ControlAxes& controls) const {
  if (!std::isfinite(controls.roll) || !std::isfinite(controls.pitch) ||
      !std::isfinite(controls.yaw) || !std::isfinite(controls.throttle) ||
      !std::isfinite(controls.tilt) ||
      (controls.allocation_blend && !std::isfinite(*controls.allocation_blend))) {
    throw std::invalid_argument("SimpleFlight mixer controls must be finite.");
  }

  const double tilt = std::clamp(controls.tilt, 0.0, 1.0);
  const double blend = std::clamp(controls.allocation_blend.value_or(tilt), 0.0, 1.0);
  const std::array<double, 5> input{
      controls.roll, controls.pitch, controls.yaw, controls.throttle, tilt};
  std::vector<double> output(parameters_.actuator_count, 0.0);
  for (std::size_t actuator = 0; actuator < parameters_.actuator_count; ++actuator) {
    for (std::size_t axis = 0; axis < input.size(); ++axis) {
      if (controls.collective_tilt_only && actuator >= 4 && actuator < 8 && axis == 2)
        continue;  // Yaw remains on rotor torque pairs; nacelles move together.
      const double coefficient = kMultirotorMatrix[actuator][axis] * (1.0 - blend) +
                                 kFixedWingMatrix[actuator][axis] * blend;
      output[actuator] += coefficient * input[axis];
    }
  }

  const auto rotor_end = output.begin() + static_cast<std::ptrdiff_t>(parameters_.rotor_count);
  const double rotor_min = *std::min_element(output.begin(), rotor_end);
  if (rotor_min < parameters_.minimum_rotor_output) {
    const double offset = parameters_.minimum_rotor_output - rotor_min;
    for (std::size_t rotor = 0; rotor < parameters_.rotor_count; ++rotor) output[rotor] += offset;
  }

  const double rotor_max = *std::max_element(output.begin(), rotor_end);
  if (rotor_max > parameters_.maximum_rotor_output) {
    const double scale = rotor_max / parameters_.maximum_rotor_output;
    for (std::size_t rotor = 0; rotor < parameters_.rotor_count; ++rotor) output[rotor] /= scale;
  }

  for (std::size_t actuator = parameters_.rotor_count; actuator < output.size(); ++actuator) {
    output[actuator] = std::clamp(output[actuator], parameters_.minimum_control_output,
                                 parameters_.maximum_control_output);
  }
  return output;
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
