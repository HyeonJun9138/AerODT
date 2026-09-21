#include "aerodt/digital_twin/simulation/control/simple_flight/flight_mode_transition.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::control::simple_flight {

FlightModeTransition::FlightModeTransition(FlightModeTransitionParameters parameters)
    : parameters_(parameters) {
  if (!std::isfinite(parameters_.stall_speed_mps) ||
      !std::isfinite(parameters_.speed_transition_mps) ||
      parameters_.stall_speed_mps < 0.0 || parameters_.speed_transition_mps < 0.0 ||
      parameters_.confirmation_count < 2 ||
      parameters_.transition_duration.count() <= 0) {
    throw std::invalid_argument("SimpleFlight transition parameters are invalid.");
  }
}

void FlightModeTransition::Reset() noexcept {
  mode_ = FlightMode::multirotor;
  fixed_wing_blend_ = 0.0;
  speed_confirmation_count_ = 0;
}

FlightModeTransitionOutput FlightModeTransition::Update(
    double horizontal_speed_mps, bool fixed_wing_requested,
    std::chrono::nanoseconds step) {
  const double dt = std::chrono::duration<double>(step).count();
  if (!std::isfinite(horizontal_speed_mps) || horizontal_speed_mps < 0.0 ||
      !std::isfinite(dt) || dt <= 0.0) {
    throw std::invalid_argument("SimpleFlight transition update input is invalid.");
  }

  if (horizontal_speed_mps <= parameters_.stall_speed_mps) {
    if (speed_confirmation_count_ > 0) --speed_confirmation_count_;
  } else if (horizontal_speed_mps >
             parameters_.stall_speed_mps + parameters_.speed_transition_mps) {
    if (speed_confirmation_count_ < parameters_.confirmation_count) {
      ++speed_confirmation_count_;
    }
  }

  bool mode_changed = false;
  if (mode_ == FlightMode::fixed_wing) {
    if (!fixed_wing_requested || speed_confirmation_count_ <= 1) {
      mode_ = FlightMode::multirotor;
      mode_changed = true;
    }
  } else if (fixed_wing_requested &&
             speed_confirmation_count_ >= parameters_.confirmation_count - 1) {
    mode_ = FlightMode::fixed_wing;
    mode_changed = true;
  }

  // ProjectAirSim restarts the transition clock when a mode changes, so that
  // switching tick contributes no blend time.
  if (!mode_changed) {
    const double blend_delta =
        dt / std::chrono::duration<double>(parameters_.transition_duration).count();
    fixed_wing_blend_ = std::clamp(
        fixed_wing_blend_ +
            (mode_ == FlightMode::fixed_wing ? blend_delta : -blend_delta),
        0.0, 1.0);
  }
  return State();
}

FlightModeTransitionOutput FlightModeTransition::State() const noexcept {
  return {
      .mode = mode_,
      .fixed_wing_blend = fixed_wing_blend_,
      .speed_confirmation_count = speed_confirmation_count_,
  };
}

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
