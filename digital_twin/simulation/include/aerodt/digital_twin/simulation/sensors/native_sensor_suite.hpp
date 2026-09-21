#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

#include "aerodt/digital_twin/contracts/sensor_frame.hpp"
#include "aerodt/digital_twin/contracts/vehicle_state.hpp"

namespace aerodt::digital_twin::simulation::sensors {

struct SensorMount {
  foundation::math::Vector3 position_body_m{};
  foundation::math::Quaternion orientation_sensor_to_body{};
};

struct ImuSensorParameters {
  std::string id;
  bool enabled{true};
  std::chrono::nanoseconds sample_interval{};
  SensorMount mount;
};

struct GpsSensorParameters {
  std::string id;
  bool enabled{true};
  std::chrono::nanoseconds sample_interval{};
  SensorMount mount;
};

struct CameraSensorParameters {
  std::string id;
  bool enabled{true};
  std::chrono::nanoseconds sample_interval{};
  SensorMount mount;
  std::uint32_t width_px{};
  std::uint32_t height_px{};
  double horizontal_fov_deg{};
  std::vector<int> enabled_image_types;
};

struct NativeSensorSuiteParameters {
  double home_latitude_deg{};
  double home_longitude_deg{};
  double home_altitude_m{};
  double gravity_mps2{9.80665};
  std::vector<ImuSensorParameters> imu;
  std::vector<GpsSensorParameters> gps;
  std::vector<CameraSensorParameters> cameras;
};

// Deterministic ideal-sensor V1. Sampling is driven exclusively by simulation
// time so wall-clock speed and Unreal frame rate cannot change its outputs.
class NativeSensorSuite final {
 public:
  explicit NativeSensorSuite(NativeSensorSuiteParameters parameters);

  void Reset(const contracts::VehicleState& initial_state);
  [[nodiscard]] contracts::SensorFrame Update(
      const std::string& entity_id, const contracts::VehicleState& state);
  [[nodiscard]] const NativeSensorSuiteParameters& Parameters() const noexcept;

 private:
  struct Schedule {
    std::chrono::nanoseconds next_sample{};
    std::uint64_t sequence{};
  };

  [[nodiscard]] static bool IsDue(
      Schedule& schedule, std::chrono::nanoseconds interval,
      std::chrono::nanoseconds now);
  void Validate() const;

  NativeSensorSuiteParameters parameters_;
  std::vector<Schedule> imu_schedules_;
  std::vector<Schedule> gps_schedules_;
  std::vector<Schedule> camera_schedules_;
};

}  // namespace aerodt::digital_twin::simulation::sensors
