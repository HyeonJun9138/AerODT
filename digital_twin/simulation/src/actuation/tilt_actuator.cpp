#include "aerodt/digital_twin/simulation/actuation/tilt_actuator.hpp"

#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::actuation {

TiltActuator::TiltActuator(TiltParameters parameters) : parameters_(parameters) {
  const double axis_norm = parameters_.axis.Norm();
  if (axis_norm <= 1e-12 || !parameters_.axis.IsFinite()) {
    throw std::invalid_argument("Tilt axis must be finite and non-zero.");
  }
  if (!std::isfinite(parameters_.angle_min_rad) ||
      !std::isfinite(parameters_.angle_max_rad) ||
      parameters_.angle_max_rad < parameters_.angle_min_rad) {
    throw std::invalid_argument("Tilt angle range is invalid.");
  }
  if (!std::isfinite(parameters_.smoothing_time_constant_s) ||
      parameters_.smoothing_time_constant_s < 0.0) {
    throw std::invalid_argument("Tilt smoothing time constant is invalid.");
  }
  parameters_.axis = parameters_.axis / axis_norm;
}

void TiltActuator::Reset(double initial_control) { filtered_control_ = initial_control; }

TiltOutput TiltActuator::Update(double mapped_control, std::chrono::nanoseconds step) {
  const double dt = std::chrono::duration<double>(step).count();
  if (!std::isfinite(mapped_control) || dt <= 0.0) {
    throw std::invalid_argument("Tilt update input is invalid.");
  }
  if (parameters_.smoothing_time_constant_s == 0.0) {
    filtered_control_ = mapped_control;
  } else {
    const double alpha = std::exp(-dt / parameters_.smoothing_time_constant_s);
    filtered_control_ = filtered_control_ * alpha + mapped_control * (1.0 - alpha);
  }
  const double angle = parameters_.angle_min_rad +
                       (parameters_.angle_max_rad - parameters_.angle_min_rad) *
                           filtered_control_;
  return {
      .mapped_control = mapped_control,
      .filtered_control = filtered_control_,
      .angle_rad = angle,
      .rotation = foundation::math::Quaternion::FromAxisAngle(parameters_.axis, angle),
  };
}

}  // namespace aerodt::digital_twin::simulation::actuation
