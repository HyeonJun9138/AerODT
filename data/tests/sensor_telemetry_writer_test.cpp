#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>

#include "aerodt/data/sensor_telemetry_writer.hpp"

void TestSensorTelemetryWriter() {
  namespace contracts = aerodt::digital_twin::contracts;
  const auto path = std::filesystem::temp_directory_path() /
                    "aerodt_sensor_telemetry_test.jsonl";
  std::filesystem::remove(path);
  aerodt::data::SensorTelemetryCounts counts;
  {
    aerodt::data::SensorTelemetryWriter writer(path);
    contracts::SensorFrame frame;
    frame.time.elapsed = std::chrono::milliseconds(20);
    frame.time.step = 7;
    frame.imu.push_back({
        .header = {.sensor_id = "IMU1", .entity_id = "UAM1", .sequence = 1,
                   .time = frame.time},
        .specific_force_sensor_mps2 = {0.0, 0.0, -9.80665},
    });
    frame.gps.push_back({
        .header = {.sensor_id = "GPS", .entity_id = "UAM1", .sequence = 1,
                   .time = frame.time},
        .latitude_deg = 37.5665,
        .longitude_deg = 126.978,
        .altitude_m = 42.0,
        .has_3d_fix = true,
    });
    frame.cameras.push_back({
        .header = {.sensor_id = "DownCamera", .entity_id = "UAM1",
                   .sequence = 1, .time = frame.time},
        .width_px = 400,
        .height_px = 225,
        .horizontal_fov_deg = 90.0,
        .focal_length_x_px = 200.0,
        .focal_length_y_px = 200.0,
        .principal_point_x_px = 199.5,
        .principal_point_y_px = 112.0,
        .enabled_image_types = {0, 2},
    });
    writer.Write(frame);
    writer.Flush();
    counts = writer.Counts();
  }
  if (counts.frames != 1 || counts.imu != 1 || counts.gps != 1 ||
      counts.cameras != 1) {
    throw std::runtime_error("Telemetry writer sample counts are incorrect.");
  }
  std::ifstream stream(path);
  const std::string text((std::istreambuf_iterator<char>(stream)),
                         std::istreambuf_iterator<char>());
  stream.close();
  if (text.find("\"sensor_id\":\"IMU1\"") == std::string::npos ||
      text.find("\"has_3d_fix\":true") == std::string::npos ||
      text.find("\"enabled_image_types\":[0,2]") == std::string::npos) {
    throw std::runtime_error("Telemetry writer omitted a native sensor field.");
  }
  std::filesystem::remove(path);
}
