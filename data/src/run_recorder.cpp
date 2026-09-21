#include "aerodt/data/run_recorder.hpp"

#include <fstream>
#include <iomanip>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <utility>

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

std::string MakeRunId(std::chrono::system_clock::time_point now) {
  const auto value = std::chrono::system_clock::to_time_t(now);
  std::tm utc{};
#ifdef _WIN32
  gmtime_s(&utc, &value);
#else
  gmtime_r(&value, &utc);
#endif
  std::mt19937 generator(std::random_device{}());
  std::uniform_int_distribution<unsigned int> distribution(0, 0xffffffff);
  std::ostringstream output;
  output << std::put_time(&utc, "%Y%m%dT%H%M%SZ") << '-' << std::hex
         << std::setw(8) << std::setfill('0') << distribution(generator);
  return output.str();
}

const char* ToString(RunStatus status) {
  switch (status) {
    case RunStatus::passed: return "passed";
    case RunStatus::failed: return "failed";
    case RunStatus::aborted: return "aborted";
  }
  return "unknown";
}

}  // namespace

RunRecorder::RunRecorder(const std::filesystem::path& workspace,
                         std::string application,
                         std::map<std::string, std::string> metadata)
    : application_(std::move(application)),
      metadata_(std::move(metadata)),
      started_at_(std::chrono::system_clock::now()) {
  if (application_.empty()) {
    throw std::invalid_argument("Run recorder application must not be empty.");
  }
  const auto runs_directory = workspace / "logs" / "runs";
  std::error_code error;
  std::filesystem::create_directories(runs_directory, error);
  if (error) {
    throw std::runtime_error("Unable to create AeroDT runs directory: " +
                             error.message());
  }

  for (int attempt = 0; attempt < 4; ++attempt) {
    run_id_ = MakeRunId(started_at_);
    run_directory_ = runs_directory / run_id_;
    if (std::filesystem::create_directory(run_directory_, error)) break;
    if (error) {
      throw std::runtime_error("Unable to create AeroDT run directory: " +
                               error.message());
    }
  }
  if (!std::filesystem::is_directory(run_directory_)) {
    throw std::runtime_error("Unable to allocate a unique AeroDT run ID.");
  }

  events_path_ = run_directory_ / "events.jsonl";
  manifest_path_ = run_directory_ / "manifest.json";
  events_ = std::make_unique<JsonlRunLogger>(events_path_);
  WriteManifest("running", "");
}

RunRecorder::~RunRecorder() noexcept {
  if (finished_) return;
  try {
    WriteManifest("aborted", "RunRecorder destroyed before Finish.");
  } catch (...) {
    // Destructors must not hide the original simulation failure.
  }
}

void RunRecorder::Write(const RunEvent& event) { events_->Write(event); }

void RunRecorder::Finish(RunStatus status, std::string error) {
  const std::scoped_lock lock(mutex_);
  if (finished_) {
    throw std::logic_error("AeroDT run recorder was already finished.");
  }
  if (status == RunStatus::passed && !error.empty()) {
    throw std::invalid_argument("A passed run cannot contain an error.");
  }
  WriteManifest(ToString(status), error);
  finished_ = true;
}

const std::string& RunRecorder::RunId() const noexcept { return run_id_; }

const std::filesystem::path& RunRecorder::RunDirectory() const noexcept {
  return run_directory_;
}

const std::filesystem::path& RunRecorder::EventsPath() const noexcept {
  return events_path_;
}

const std::filesystem::path& RunRecorder::ManifestPath() const noexcept {
  return manifest_path_;
}

void RunRecorder::WriteManifest(std::string_view status, std::string_view error) {
  const auto now = std::chrono::system_clock::now();
  const auto duration = std::chrono::duration<double>(now - started_at_).count();
  const std::filesystem::path temporary = manifest_path_.string() + ".tmp";
  std::ofstream output(temporary, std::ios::out | std::ios::trunc);
  if (!output) {
    throw std::runtime_error("Unable to write AeroDT run manifest.");
  }
  output << "{\n"
         << "  \"schema_version\": 1,\n"
         << "  \"run_id\": \"" << Escape(run_id_) << "\",\n"
         << "  \"application\": \"" << Escape(application_) << "\",\n"
         << "  \"status\": \"" << Escape(status) << "\",\n"
         << "  \"started_at\": \"" << Timestamp(started_at_) << "\",\n";
  if (status != "running") {
    output << "  \"finished_at\": \"" << Timestamp(now) << "\",\n"
           << "  \"duration_seconds\": " << std::fixed << std::setprecision(6)
           << duration << ",\n";
  }
  if (!error.empty()) {
    output << "  \"error\": \"" << Escape(error) << "\",\n";
  }
  output << "  \"metadata\": {";
  bool first = true;
  for (const auto& [key, value] : metadata_) {
    output << (first ? "\n" : ",\n") << "    \"" << Escape(key) << "\": \""
           << Escape(value) << "\"";
    first = false;
  }
  if (!metadata_.empty()) output << '\n';
  output << "  }\n}\n";
  output.close();
  if (!output) {
    throw std::runtime_error("Unable to flush AeroDT run manifest.");
  }

  std::error_code filesystem_error;
  std::filesystem::remove(manifest_path_, filesystem_error);
  filesystem_error.clear();
  std::filesystem::rename(temporary, manifest_path_, filesystem_error);
  if (filesystem_error) {
    std::filesystem::remove(temporary);
    throw std::runtime_error("Unable to publish AeroDT run manifest: " +
                             filesystem_error.message());
  }
}

}  // namespace aerodt::data
