#pragma once

#include <chrono>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>

#include "aerodt/data/jsonl_run_logger.hpp"

namespace aerodt::data {

enum class RunStatus { passed, failed, aborted };

// Owns one run directory, its append-only event stream, and an atomic manifest.
// The destructor records an aborted manifest if Finish was not called.
class RunRecorder final {
 public:
  RunRecorder(const std::filesystem::path& workspace,
              std::string application,
              std::map<std::string, std::string> metadata = {});
  ~RunRecorder() noexcept;

  RunRecorder(const RunRecorder&) = delete;
  RunRecorder& operator=(const RunRecorder&) = delete;
  RunRecorder(RunRecorder&&) = delete;
  RunRecorder& operator=(RunRecorder&&) = delete;

  void Write(const RunEvent& event);
  void Finish(RunStatus status, std::string error = {});

  [[nodiscard]] const std::string& RunId() const noexcept;
  [[nodiscard]] const std::filesystem::path& RunDirectory() const noexcept;
  [[nodiscard]] const std::filesystem::path& EventsPath() const noexcept;
  [[nodiscard]] const std::filesystem::path& ManifestPath() const noexcept;

 private:
  void WriteManifest(std::string_view status, std::string_view error);

  std::string run_id_;
  std::string application_;
  std::map<std::string, std::string> metadata_;
  std::filesystem::path run_directory_;
  std::filesystem::path events_path_;
  std::filesystem::path manifest_path_;
  std::chrono::system_clock::time_point started_at_;
  std::unique_ptr<JsonlRunLogger> events_;
  std::mutex mutex_;
  bool finished_{};
};

}  // namespace aerodt::data
