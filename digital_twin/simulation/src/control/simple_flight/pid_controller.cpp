#include "aerodt/digital_twin/simulation/control/simple_flight/pid_controller.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::control::simple_flight {

PidController::PidController(PidParameters parameters) : parameters_(parameters) {
  if (!std::isfinite(parameters_.proportional_gain) ||
      !std::isfinite(parameters_.integral_gain) ||
      !std::isfinite(parameters_.derivative_gain) ||
      !std::isfinite(parameters_.minimum_output) ||
      !std::isfinite(parameters_.maximum_output) ||
      parameters_.minimum_output > parameters_.maximum_output ||
      !std::isfinite(parameters_.output_bias) ||
      !std::isfinite(parameters_.integral_discount) ||
      parameters_.integral_discount < 0.0 ||
      !std::isfinite(parameters_.minimum_step_seconds) ||
      parameters_.minimum_step_seconds < 0.0) {
    throw std::invalid_argument("SimpleFlight PID parameters are invalid.");
  }
  Reset();
}

void PidController::Reset(double goal, double measured) {
  if (!std::isfinite(goal) || !std::isfinite(measured)) {
    throw std::invalid_argument("SimpleFlight PID reset values must be finite.");
  }
  integral_term_ = 0.0;
  last_error_ = goal - measured;
  output_ = 0.0;
}

void PidController::ClearIntegral() noexcept { integral_term_ = 0.0; }

double PidController::Update(double goal, double measured, double step_seconds) {
  if (!std::isfinite(goal) || !std::isfinite(measured) ||
      !std::isfinite(step_seconds) || step_seconds < 0.0) {
    throw std::invalid_argument("SimpleFlight PID inputs must be finite and step non-negative.");
  }
  if (!parameters_.enabled) return output_;

  const double error = goal - measured;
  const double proportional_term = error * parameters_.proportional_gain;
  double derivative_term = 0.0;
  if (step_seconds > parameters_.minimum_step_seconds) {
    const double discounted_integral = integral_term_ * parameters_.integral_discount;
    integral_term_ = integral_term_ * parameters_.integral_discount +
                     step_seconds * error * parameters_.integral_gain;
    integral_term_ = std::clamp(integral_term_, parameters_.minimum_output,
                                parameters_.maximum_output);
    derivative_term =
        ((error - last_error_) / step_seconds) * parameters_.derivative_gain;
    const double unconstrained = parameters_.output_bias + proportional_term +
                                 integral_term_ + derivative_term;
    const double integral_direction = error * parameters_.integral_gain;
    if (parameters_.conditional_integration &&
        ((unconstrained > parameters_.maximum_output && integral_direction > 0.0) ||
         (unconstrained < parameters_.minimum_output && integral_direction < 0.0))) {
      // Do not charge an integral behind a saturated output. Opposite-signed
      // error can still unwind it; legacy controllers opt out by default.
      integral_term_ = discounted_integral;
    }
    last_error_ = error;
  }

  output_ = std::clamp(parameters_.output_bias + proportional_term + integral_term_ +
                           derivative_term,
                       parameters_.minimum_output, parameters_.maximum_output);
  return output_;
}

double PidController::Output() const noexcept { return output_; }

double PidController::IntegralTerm() const noexcept { return integral_term_; }

}  // namespace aerodt::digital_twin::simulation::control::simple_flight
