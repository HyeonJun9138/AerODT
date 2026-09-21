#pragma once

#include <string_view>

namespace aerodt::foundation::diagnostics {

enum class LogLevel { trace, debug, info, warning, error, critical };

[[nodiscard]] constexpr std::string_view ToString(LogLevel level) noexcept {
  switch (level) {
    case LogLevel::trace: return "trace";
    case LogLevel::debug: return "debug";
    case LogLevel::info: return "info";
    case LogLevel::warning: return "warning";
    case LogLevel::error: return "error";
    case LogLevel::critical: return "critical";
  }
  return "unknown";
}

}  // namespace aerodt::foundation::diagnostics
