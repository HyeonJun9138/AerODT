#pragma once

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <mutex>

#include "aerodt/digital_twin/contracts/sensor_frame.hpp"

namespace aerodt::data {

struct SensorTelemetryCounts {
  std::uint64_t frames{};
  std::uint64_t imu{};
  std::uint64_t gps{};
  std::uint64_t cameras{};
};

// Data Layer publication sink for immutable native sensor samples. The file is
// append-only JSONL and belongs to the same run directory as its manifest.
class SensorTelemetryWriter final {
 public:
  explicit SensorTelemetryWriter(const std::filesystem::path& path);
  ~SensorTelemetryWriter() noexcept;

  SensorTelemetryWriter(const SensorTelemetryWriter&) = delete;
  SensorTelemetryWriter& operator=(const SensorTelemetryWriter&) = delete;

  void Write(const digital_twin::contracts::SensorFrame& frame);
  void Flush();
  [[nodiscard]] const std::filesystem::path& Path() const noexcept;
  [[nodiscard]] SensorTelemetryCounts Counts() const;

 private:
  std::filesystem::path path_;
  std::ofstream output_;
  mutable std::mutex mutex_;
  SensorTelemetryCounts counts_;
};

}  // namespace aerodt::data
