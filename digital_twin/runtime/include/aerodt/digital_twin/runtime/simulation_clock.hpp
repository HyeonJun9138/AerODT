#pragma once

#include <chrono>

#include "aerodt/foundation/time/simulation_time.hpp"

namespace aerodt::digital_twin::runtime {

// The one clock every entity in a simulation world advances on. It counts
// fixed steps from zero; wall-clock pacing and time scaling belong to the
// host that calls Advance (the headless loop or the Unreal tick), not here.
class SimulationClock final {
 public:
  explicit SimulationClock(std::chrono::nanoseconds step);

  void Reset() noexcept;
  // The time after one more step; also what the step's snapshots carry.
  foundation::time::SimulationTime Advance() noexcept;
  [[nodiscard]] foundation::time::SimulationTime Now() const noexcept;
  [[nodiscard]] std::chrono::nanoseconds Step() const noexcept;

 private:
  std::chrono::nanoseconds step_;
  foundation::time::SimulationTime now_{};
};

}  // namespace aerodt::digital_twin::runtime
