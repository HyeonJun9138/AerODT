#include "aerodt/data/jsonl_run_logger.hpp"

#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace aerodt::data {
namespace {

std::string Escape(std::string_view value) {
  std::string escaped;
  escaped.reserve(value.size());
  for (const char ch : value) {
    switch (ch) {
      case '\\': escaped += "\\\\"; break;
      case '"': escaped += "\\\""; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default: escaped += ch; break;
    }
  }
  return escaped;
}

std::string Timestamp(std::chrono::system_clock::time_point point) {
  const auto value = std::chrono::system_clock::to_time_t(point);
  std::tm utc{};
#ifdef _WIN32
  gmtime_s(&utc, &value);
#else
  gmtime_r(&value, &utc);
#endif
  std::ostringstream output;
  output << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ");
  return output.str();
}

}  // namespace

JsonlRunLogger::JsonlRunLogger(const std::filesystem::path& path) {
  if (path.has_parent_path()) {
    std::filesystem::create_directories(path.parent_path());
  }
  stream_.open(path, std::ios::out | std::ios::app);
  if (!stream_) {
    throw std::runtime_error("Unable to open AeroDT run log: " + path.string());
  }
}

void JsonlRunLogger::Write(const RunEvent& event) {
  const std::scoped_lock lock(mutex_);
  stream_ << "{\"timestamp\":\"" << Timestamp(event.timestamp)
          << "\",\"level\":\"" << foundation::diagnostics::ToString(event.level)
          << "\",\"component\":\"" << Escape(event.component)
          << "\",\"event\":\"" << Escape(event.event)
          << "\",\"message\":\"" << Escape(event.message) << "\"}\n";
  stream_.flush();
}

}  // namespace aerodt::data
