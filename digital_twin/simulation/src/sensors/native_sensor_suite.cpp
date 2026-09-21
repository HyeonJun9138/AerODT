#include "aerodt/digital_twin/simulation/sensors/native_sensor_suite.hpp"

#include <cmath>
#include <numbers>
#include <stdexcept>
#include <unordered_set>
#include <utility>

namespace aerodt::digital_twin::simulation::sensors {
namespace {

constexpr double kEarthEquatorialRadiusM = 6378137.0;

bool ValidMount(const SensorMount& mount) {
  return mount.position_body_m.IsFinite() &&
         mount.orientation_sensor_to_body.IsFinite();
}

contracts::SensorSampleHeader Header(
    const std::string& sensor_id, const std::string& entity_id,
    std::uint64_t sequence, const foundation::time::SimulationTime& time) {
  return {.sensor_id = sensor_id,
          .entity_id = entity_id,
          .sequence = sequence,
          .time = time};
}

}  // namespace

NativeSensorSuite::NativeSensorSuite(NativeSensorSuiteParameters parameters)
    : parameters_(std::move(parameters)),
      imu_schedules_(parameters_.imu.size()),
      gps_schedules_(parameters_.gps.size()),
      camera_schedules_(parameters_.cameras.size()) {
  Validate();
}

void NativeSensorSuite::Reset(const contracts::VehicleState& initial_state) {
  const auto reset = [&initial_state](auto& schedules, const auto& sensors) {
    for (std::size_t index = 0; index < schedules.size(); ++index) {
      schedules[index] = {
          .next_sample = initial_state.time.elapsed + sensors[index].sample_interval,
          .sequence = 0,
      };
    }
  };
  reset(imu_schedules_, parameters_.imu);
  reset(gps_schedules_, parameters_.gps);
  reset(camera_schedules_, parameters_.cameras);
}

contracts::SensorFrame NativeSensorSuite::Update(
    const std::string& entity_id, const contracts::VehicleState& state) {
  if (entity_id.empty()) {
    throw std::invalid_argument("Native sensor publication requires an entity ID.");
  }
  contracts::SensorFrame frame{.time = state.time};

  const foundation::math::Vector3 gravity_ned{0.0, 0.0,
                                               parameters_.gravity_mps2};
  const auto body_to_ned = state.orientation_body_to_ned.Normalized();
  const auto specific_force_body = body_to_ned.Conjugate().Rotate(
      state.linear_acceleration_ned_mps2 - gravity_ned);

  for (std::size_t index = 0; index < parameters_.imu.size(); ++index) {
    const auto& sensor = parameters_.imu[index];
    auto& schedule = imu_schedules_[index];
    if (!sensor.enabled || !IsDue(schedule, sensor.sample_interval,
                                  state.time.elapsed)) {
      continue;
    }
    const auto sensor_to_body = sensor.mount.orientation_sensor_to_body.Normalized();
    frame.imu.push_back({
        .header = Header(sensor.id, entity_id, schedule.sequence, state.time),
        .orientation_sensor_to_ned = (body_to_ned * sensor_to_body).Normalized(),
        .angular_velocity_sensor_radps =
            sensor_to_body.Conjugate().Rotate(state.angular_velocity_body_radps),
        .specific_force_sensor_mps2 =
            sensor_to_body.Conjugate().Rotate(specific_force_body),
    });
  }

  const double latitude_rad =
      parameters_.home_latitude_deg * std::numbers::pi / 180.0;
  for (std::size_t index = 0; index < parameters_.gps.size(); ++index) {
    const auto& sensor = parameters_.gps[index];
    auto& schedule = gps_schedules_[index];
    if (!sensor.enabled || !IsDue(schedule, sensor.sample_interval,
                                  state.time.elapsed)) {
      continue;
    }
    const auto sensor_position_ned = state.position_ned_m +
        body_to_ned.Rotate(sensor.mount.position_body_m);
    const double latitude_deg = parameters_.home_latitude_deg +
        (sensor_position_ned.x / kEarthEquatorialRadiusM) * 180.0 /
            std::numbers::pi;
    const double longitude_scale =
        kEarthEquatorialRadiusM * std::cos(latitude_rad);
    if (std::abs(longitude_scale) <= 1.0) {
      throw std::runtime_error("GPS local tangent conversion is singular near a pole.");
    }
    const double longitude_deg = parameters_.home_longitude_deg +
        (sensor_position_ned.y / longitude_scale) * 180.0 /
            std::numbers::pi;
    frame.gps.push_back({
        .header = Header(sensor.id, entity_id, schedule.sequence, state.time),
        .latitude_deg = latitude_deg,
        .longitude_deg = longitude_deg,
        .altitude_m = parameters_.home_altitude_m - sensor_position_ned.z,
        .velocity_ned_mps = state.linear_velocity_ned_mps,
        .has_3d_fix = true,
    });
  }

  for (std::size_t index = 0; index < parameters_.cameras.size(); ++index) {
    const auto& sensor = parameters_.cameras[index];
    auto& schedule = camera_schedules_[index];
    if (!sensor.enabled || !IsDue(schedule, sensor.sample_interval,
                                  state.time.elapsed)) {
      continue;
    }
    const double fov_rad = sensor.horizontal_fov_deg * std::numbers::pi / 180.0;
    const double focal = static_cast<double>(sensor.width_px) /
                         (2.0 * std::tan(fov_rad / 2.0));
    frame.cameras.push_back({
        .header = Header(sensor.id, entity_id, schedule.sequence, state.time),
        .position_ned_m = state.position_ned_m +
            body_to_ned.Rotate(sensor.mount.position_body_m),
        .orientation_camera_to_ned =
            (body_to_ned * sensor.mount.orientation_sensor_to_body).Normalized(),
        .width_px = sensor.width_px,
        .height_px = sensor.height_px,
        .horizontal_fov_deg = sensor.horizontal_fov_deg,
        .focal_length_x_px = focal,
        .focal_length_y_px = focal,
        .principal_point_x_px = (static_cast<double>(sensor.width_px) - 1.0) / 2.0,
        .principal_point_y_px = (static_cast<double>(sensor.height_px) - 1.0) / 2.0,
        .enabled_image_types = sensor.enabled_image_types,
    });
  }
  return frame;
}

const NativeSensorSuiteParameters& NativeSensorSuite::Parameters() const noexcept {
  return parameters_;
}

bool NativeSensorSuite::IsDue(Schedule& schedule,
                              std::chrono::nanoseconds interval,
                              std::chrono::nanoseconds now) {
  if (now < schedule.next_sample) return false;
  do {
    schedule.next_sample += interval;
  } while (schedule.next_sample <= now);
  ++schedule.sequence;
  return true;
}

void NativeSensorSuite::Validate() const {
  if (!std::isfinite(parameters_.home_latitude_deg) ||
      !std::isfinite(parameters_.home_longitude_deg) ||
      !std::isfinite(parameters_.home_altitude_m) ||
      std::abs(parameters_.home_latitude_deg) > 90.0 ||
      std::abs(parameters_.home_longitude_deg) > 180.0 ||
      !std::isfinite(parameters_.gravity_mps2) ||
      parameters_.gravity_mps2 <= 0.0) {
    throw std::invalid_argument("Native sensor world parameters are invalid.");
  }
  std::unordered_set<std::string> ids;
  const auto validate_common = [&ids](const auto& sensor) {
    if (sensor.id.empty() || !ids.insert(sensor.id).second ||
        sensor.sample_interval.count() <= 0 || !ValidMount(sensor.mount)) {
      throw std::invalid_argument(
          "Native sensor ID, interval, or mount is invalid.");
    }
  };
  for (const auto& sensor : parameters_.imu) validate_common(sensor);
  for (const auto& sensor : parameters_.gps) validate_common(sensor);
  for (const auto& sensor : parameters_.cameras) {
    validate_common(sensor);
    if (sensor.width_px == 0 || sensor.height_px == 0 ||
        !std::isfinite(sensor.horizontal_fov_deg) ||
        sensor.horizontal_fov_deg <= 0.0 || sensor.horizontal_fov_deg >= 180.0 ||
        sensor.enabled_image_types.empty()) {
      throw std::invalid_argument("Native camera intrinsics are invalid.");
    }
  }
}

}  // namespace aerodt::digital_twin::simulation::sensors
