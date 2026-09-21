#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>

#include "aerodt/data/jsonl_run_logger.hpp"

void TestRunRecorder();
void TestSensorTelemetryWriter();

void TestJsonlRunLogger() {
  const auto path = std::filesystem::temp_directory_path() / "aerodt_jsonl_run_logger_test.jsonl";
  std::filesystem::remove(path);
  {
    aerodt::data::JsonlRunLogger logger(path);
    logger.Write({.component = "test", .event = "escape", .message = "line\n\"quoted\""});
  }
  std::ifstream input(path);
  const std::string content((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
  input.close();
  if (content.find("\"component\":\"test\"") == std::string::npos) {
    throw std::runtime_error("JSONL component was not written.");
  }
  if (content.find("line\\n\\\"quoted\\\"") == std::string::npos) {
    throw std::runtime_error("JSONL message was not escaped.");
  }
  std::filesystem::remove(path);
}

int main() {
  try {
    TestJsonlRunLogger();
    TestRunRecorder();
    TestSensorTelemetryWriter();
    std::cout << "AERODT_DATA=PASS\n";
    return 0;
  } catch (const std::exception& exception) {
    std::cerr << "AERODT_DATA=FAIL: " << exception.what() << '\n';
    return 1;
  }
}
