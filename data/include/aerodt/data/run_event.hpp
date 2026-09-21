#pragma once

#include <chrono>
#include <string>

#include "aerodt/foundation/diagnostics/log_level.hpp"

namespace aerodt::data {

struct RunEvent {
  std::chrono::system_clock::time_point timestamp{std::chrono::system_clock::now()};
  foundation::diagnostics::LogLevel level{foundation::diagnostics::LogLevel::info};
  std::string component;
  std::string event;
  std::string message;
};

}  // namespace aerodt::data
