#pragma once

#include <filesystem>
#include <fstream>
#include <mutex>

#include "aerodt/data/run_event.hpp"

namespace aerodt::data {

class JsonlRunLogger final {
 public:
  explicit JsonlRunLogger(const std::filesystem::path& path);
  void Write(const RunEvent& event);

 private:
  std::ofstream stream_;
  std::mutex mutex_;
};

}  // namespace aerodt::data
