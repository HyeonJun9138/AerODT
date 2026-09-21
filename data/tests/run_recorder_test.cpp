#include <chrono>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>

#include "aerodt/data/run_recorder.hpp"

void TestRunRecorder() {
  const auto workspace = std::filesystem::temp_directory_path() /
                         ("aerodt_run_recorder_test_" +
                          std::to_string(std::chrono::steady_clock::now()
                                             .time_since_epoch()
                                             .count()));
  std::filesystem::path manifest;
  std::filesystem::path events;
  {
    aerodt::data::RunRecorder recorder(
        workspace, "native-test", {{"physics", "fast-physics"}});
    manifest = recorder.ManifestPath();
    events = recorder.EventsPath();
    recorder.Write({
        .component = "test",
        .event = "started",
        .message = "native run",
    });
    recorder.Finish(aerodt::data::RunStatus::passed);
  }

  std::ifstream manifest_stream(manifest);
  const std::string manifest_text((std::istreambuf_iterator<char>(manifest_stream)),
                                  std::istreambuf_iterator<char>());
  std::ifstream event_stream(events);
  const std::string event_text((std::istreambuf_iterator<char>(event_stream)),
                               std::istreambuf_iterator<char>());
  manifest_stream.close();
  event_stream.close();
  if (manifest_text.find("\"status\": \"passed\"") == std::string::npos ||
      manifest_text.find("\"physics\": \"fast-physics\"") == std::string::npos ||
      manifest_text.find("\"finished_at\"") == std::string::npos) {
    throw std::runtime_error("Run recorder did not publish a passed manifest.");
  }
  if (event_text.find("\"event\":\"started\"") == std::string::npos) {
    throw std::runtime_error("Run recorder did not preserve its event stream.");
  }

  std::filesystem::path aborted_manifest;
  {
    aerodt::data::RunRecorder unfinished(workspace, "unfinished-test");
    aborted_manifest = unfinished.ManifestPath();
  }
  std::ifstream aborted_stream(aborted_manifest);
  const std::string aborted_text((std::istreambuf_iterator<char>(aborted_stream)),
                                 std::istreambuf_iterator<char>());
  aborted_stream.close();
  if (aborted_text.find("\"status\": \"aborted\"") == std::string::npos) {
    throw std::runtime_error("Unfinished run was not marked aborted.");
  }
  std::filesystem::remove_all(workspace);
}
