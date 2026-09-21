#include "aerodt/digital_twin/runtime/simulation_clock.hpp"

#include <stdexcept>

namespace aerodt::digital_twin::runtime {

SimulationClock::SimulationClock(std::chrono::nanoseconds step) : step_(step) {
  if (step_.count() <= 0) {
    throw std::invalid_argument("Simulation clock step must be greater than zero.");
  }
}

void SimulationClock::Reset() noexcept { now_ = {}; }

foundation::time::SimulationTime SimulationClock::Advance() noexcept {
  now_.elapsed += step_;
  ++now_.step;
  return now_;
}

foundation::time::SimulationTime SimulationClock::Now() const noexcept { return now_; }

std::chrono::nanoseconds SimulationClock::Step() const noexcept { return step_; }

}  // namespace aerodt::digital_twin::runtime
