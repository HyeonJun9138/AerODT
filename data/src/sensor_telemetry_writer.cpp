#include "aerodt/data/sensor_telemetry_writer.hpp"

#include <iomanip>
#include <stdexcept>
#include <string_view>

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

template <typename Vector>
void WriteVector(std::ostream& output, const Vector& value) {
  output << '[' << value.x << ',' << value.y << ',' << value.z << ']';
}

template <typename Quaternion>
void WriteQuaternion(std::ostream& output, const Quaternion& value) {
  output << '[' << value.w << ',' << value.x << ',' << value.y << ','
         << value.z << ']';
}

void WriteHeader(std::ostream& output,
                 const digital_twin::contracts::SensorSampleHeader& header) {
  output << "\"sensor_id\":\"" << Escape(header.sensor_id)
         << "\",\"entity_id\":\"" << Escape(header.entity_id)
         << "\",\"sequence\":" << header.sequence
         << ",\"time_ns\":" << header.time.elapsed.count()
         << ",\"step\":" << header.time.step;
}

}  // namespace

SensorTelemetryWriter::SensorTelemetryWriter(const std::filesystem::path& path)
    : path_(path), output_(path, std::ios::out | std::ios::trunc) {
  if (path_.empty() || !output_) {
    throw std::runtime_error("Unable to create native sensor telemetry file.");
  }
  output_ << std::setprecision(17);
}

SensorTelemetryWriter::~SensorTelemetryWriter() noexcept {
  try {
    output_.flush();
  } catch (...) {
  }
}

void SensorTelemetryWriter::Write(
    const digital_twin::contracts::SensorFrame& frame) {
  if (frame.Empty()) return;
  const std::scoped_lock lock(mutex_);
  output_ << "{\"schema_version\":1,\"time_ns\":"
          << frame.time.elapsed.count() << ",\"step\":" << frame.time.step;

  output_ << ",\"imu\":[";
  for (std::size_t index = 0; index < frame.imu.size(); ++index) {
    const auto& sample = frame.imu[index];
    if (index != 0) output_ << ',';
    output_ << '{';
    WriteHeader(output_, sample.header);
    output_ << ",\"orientation_sensor_to_ned_wxyz\":";
    WriteQuaternion(output_, sample.orientation_sensor_to_ned);
    output_ << ",\"angular_velocity_sensor_radps\":";
    WriteVector(output_, sample.angular_velocity_sensor_radps);
    output_ << ",\"specific_force_sensor_mps2\":";
    WriteVector(output_, sample.specific_force_sensor_mps2);
    output_ << '}';
  }
  output_ << "],\"gps\":[";
  for (std::size_t index = 0; index < frame.gps.size(); ++index) {
    const auto& sample = frame.gps[index];
    if (index != 0) output_ << ',';
    output_ << '{';
    WriteHeader(output_, sample.header);
    output_ << ",\"latitude_deg\":" << sample.latitude_deg
            << ",\"longitude_deg\":" << sample.longitude_deg
            << ",\"altitude_m\":" << sample.altitude_m
            << ",\"velocity_ned_mps\":";
    WriteVector(output_, sample.velocity_ned_mps);
    output_ << ",\"has_3d_fix\":" << (sample.has_3d_fix ? "true" : "false")
            << '}';
  }
  output_ << "],\"cameras\":[";
  for (std::size_t index = 0; index < frame.cameras.size(); ++index) {
    const auto& sample = frame.cameras[index];
    if (index != 0) output_ << ',';
    output_ << '{';
    WriteHeader(output_, sample.header);
    output_ << ",\"position_ned_m\":";
    WriteVector(output_, sample.position_ned_m);
    output_ << ",\"orientation_camera_to_ned_wxyz\":";
    WriteQuaternion(output_, sample.orientation_camera_to_ned);
    output_ << ",\"width_px\":" << sample.width_px
            << ",\"height_px\":" << sample.height_px
            << ",\"horizontal_fov_deg\":" << sample.horizontal_fov_deg
            << ",\"focal_length_x_px\":" << sample.focal_length_x_px
            << ",\"focal_length_y_px\":" << sample.focal_length_y_px
            << ",\"principal_point_x_px\":" << sample.principal_point_x_px
            << ",\"principal_point_y_px\":" << sample.principal_point_y_px
            << ",\"enabled_image_types\":[";
    for (std::size_t type_index = 0;
         type_index < sample.enabled_image_types.size(); ++type_index) {
      if (type_index != 0) output_ << ',';
      output_ << sample.enabled_image_types[type_index];
    }
    output_ << "]}";
  }
  output_ << "]}\n";
  if (!output_) {
    throw std::runtime_error("Unable to append native sensor telemetry.");
  }
  ++counts_.frames;
  counts_.imu += frame.imu.size();
  counts_.gps += frame.gps.size();
  counts_.cameras += frame.cameras.size();
  if ((counts_.frames % 128U) == 0U) output_.flush();
}

void SensorTelemetryWriter::Flush() {
  const std::scoped_lock lock(mutex_);
  output_.flush();
  if (!output_) {
    throw std::runtime_error("Unable to flush native sensor telemetry.");
  }
}

const std::filesystem::path& SensorTelemetryWriter::Path() const noexcept {
  return path_;
}

SensorTelemetryCounts SensorTelemetryWriter::Counts() const {
  const std::scoped_lock lock(mutex_);
  return counts_;
}

}  // namespace aerodt::data
