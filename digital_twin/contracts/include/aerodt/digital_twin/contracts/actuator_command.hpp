#pragma once

#include <vector>

namespace aerodt::digital_twin::contracts {

struct ActuatorCommand {
  std::vector<double> rotor_normalized;
  std::vector<double> tilt_rad;
  std::vector<double> control_surface_rad;
};

}  // namespace aerodt::digital_twin::contracts
