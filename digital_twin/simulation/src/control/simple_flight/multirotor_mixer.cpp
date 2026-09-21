#include "aerodt/digital_twin/simulation/control/simple_flight/multirotor_mixer.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::control::simple_flight {

// ProjectAirSim SimpleFlight Mixer.hpp, QuadX: rotor order FRONT_R, REAR_L,
// FRONT_L, REAR_R (the package's actuator-order carries the same order).
const std::array<MultirotorMixer::MixerRow, 4> MultirotorMixer::kQuadXMatrix{{
    {-1.0, 1.0, 1.0, 1.0},
    {1.0, -1.0, 1.0, 1.0},
    {1.0, 1.0, -1.0, 1.0},
    {-1.0, -1.0, -1.0, 1.0},
}};

// ProjectAirSim SimpleFlight Mixer.hpp, HexX: rotors 0..5 clockwise from the
// front-right looking down along +Z.
const std::array<MultirotorMixer::MixerRow, 6> MultirotorMixer::kHexXMatrix{{
    {0.5, 1.0, -1.0, 1.0},
    {-0.5, 1.0, 1.0, 1.0},
    {-1.0, 0.0, -1.0, 1.0},
    {-0.5, -1.0, 1.0, 1.0},
    {0.5, -1.0, -1.0, 1.0},
    {1.0, 0.0, 1.0, 1.0},
}};

MultirotorMixer::MultirotorMixer(Airframe airframe, MixerParameters parameters)
    : airframe_(airframe), parameters_(parameters) {
  switch (airframe_) {
    case Airframe::quadrotor_x:
      matrix_.assign(kQuadXMatrix.begin(), kQuadXMatrix.end());
      break;
    case Airframe::hexarotor_x:
      matrix_.assign(kHexXMatrix.begin(), kHexXMatrix.end());
      break;
    default:
      throw std::invalid_argument("SimpleFlight multirotor mixer needs a multirotor airframe.");
  }
  if (parameters_.rotor_count != matrix_.size() ||
      parameters_.actuator_count < parameters_.rotor_count ||
      !std::isfinite(parameters_.minimum_rotor_output) ||
      !std::isfinite(parameters_.maximum_rotor_output) ||
      parameters_.maximum_rotor_output <= 0.0 ||
      parameters_.minimum_rotor_output > parameters_.maximum_rotor_output) {
    throw std::invalid_argument("SimpleFlight multirotor mixer parameters are invalid.");
  }
}

std::vector<double> MultirotorMixer::Mix(const ControlAxes& controls) const {
  if (!std::isfinite(controls.roll) || !std::isfinite(controls.pitch) ||
      !std::isfinite(controls.yaw) || !std::isfinite(controls.throttle) ||
      !std::isfinite(controls.tilt)) {
    throw std::invalid_argument("SimpleFlight mixer controls must be finite.");
  }
  const std::array<double, 4> input{controls.roll, controls.pitch, controls.yaw, controls.throttle};
  std::vector<double> output(parameters_.actuator_count, 0.0);
  for (std::size_t rotor = 0; rotor < matrix_.size(); ++rotor) {
    for (std::size_t axis = 0; axis < input.size(); ++axis) {
      output[rotor] += matrix_[rotor][axis] * input[axis];
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
  return output;
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
