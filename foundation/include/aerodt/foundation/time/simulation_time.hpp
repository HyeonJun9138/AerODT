#pragma once

#include <chrono>
#include <cstdint>

namespace aerodt::foundation::time {

struct SimulationTime {
  std::chrono::nanoseconds elapsed{};
  std::uint64_t step{};
};

}  // namespace aerodt::foundation::time
