#include "aerodt/digital_twin/simulation/actuation/control_surface_actuator.hpp"

#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::actuation {

ControlSurfaceActuator::ControlSurfaceActuator(ControlSurfaceParameters parameters)
    : parameters_(parameters) {
  if (!std::isfinite(parameters_.rotation_rate_rad_per_unit) ||
      !std::isfinite(parameters_.smoothing_time_constant_s) ||
      parameters_.smoothing_time_constant_s < 0.0) {
    throw std::invalid_argument("Control-surface parameters are invalid.");
  }
}

void ControlSurfaceActuator::Reset(double initial_control) {
  if (!std::isfinite(initial_control)) {
    throw std::invalid_argument("Control-surface initial control must be finite.");
  }
  filtered_control_ = initial_control;
}

ControlSurfaceOutput ControlSurfaceActuator::Update(
    double control, std::chrono::nanoseconds step) {
  const double dt = std::chrono::duration<double>(step).count();
  if (!std::isfinite(control) || !std::isfinite(dt) || dt <= 0.0) {
    throw std::invalid_argument("Control-surface update input is invalid.");
  }

  if (parameters_.smoothing_time_constant_s == 0.0) {
    filtered_control_ = control;
  } else {
    const double alpha = std::exp(-dt / parameters_.smoothing_time_constant_s);
    filtered_control_ = filtered_control_ * alpha + control * (1.0 - alpha);
  }
  return {
      .filtered_control = filtered_control_,
      .angle_rad = parameters_.rotation_rate_rad_per_unit * filtered_control_,
  };
}

}  // namespace aerodt::digital_twin::simulation::actuation
