#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "aerodt/foundation/math/quaternion.hpp"
#include "aerodt/foundation/math/vector3.hpp"
#include "aerodt/foundation/time/simulation_time.hpp"

namespace aerodt::digital_twin::contracts {

struct SensorSampleHeader {
  std::string sensor_id;
  std::string entity_id;
  std::uint64_t sequence{};
  foundation::time::SimulationTime time;
};

// Ideal native IMU output. Specific force excludes gravity and is expressed in
// the sensor/body frame, matching the quantity measured by an accelerometer.
struct ImuSample {
  SensorSampleHeader header;
  foundation::math::Quaternion orientation_sensor_to_ned{};
  foundation::math::Vector3 angular_velocity_sensor_radps{};
  foundation::math::Vector3 specific_force_sensor_mps2{};
};

struct GpsSample {
  SensorSampleHeader header;
  double latitude_deg{};
  double longitude_deg{};
  double altitude_m{};
  foundation::math::Vector3 velocity_ned_mps{};
  bool has_3d_fix{};
};

// Camera state is published independently from pixels. The Unreal host can use
// this immutable pose/intrinsics description to capture or stream an image.
struct CameraStateSample {
  SensorSampleHeader header;
  foundation::math::Vector3 position_ned_m{};
  foundation::math::Quaternion orientation_camera_to_ned{};
  std::uint32_t width_px{};
  std::uint32_t height_px{};
  double horizontal_fov_deg{};
  double focal_length_x_px{};
  double focal_length_y_px{};
  double principal_point_x_px{};
  double principal_point_y_px{};
  std::vector<int> enabled_image_types;
};

// One runtime tick may publish zero or more samples according to each sensor's
// independent sampling interval. It does not own or duplicate vehicle state.
struct SensorFrame {
  foundation::time::SimulationTime time;
  std::vector<ImuSample> imu;
  std::vector<GpsSample> gps;
  std::vector<CameraStateSample> cameras;

  [[nodiscard]] bool Empty() const noexcept {
    return imu.empty() && gps.empty() && cameras.empty();
  }
};

}  // namespace aerodt::digital_twin::contracts
