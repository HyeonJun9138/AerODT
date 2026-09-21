#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>

#include "aerodt/digital_twin/simulation/sensors/native_sensor_suite.hpp"

namespace {

using aerodt::digital_twin::contracts::VehicleState;
using aerodt::digital_twin::simulation::sensors::CameraSensorParameters;
using aerodt::digital_twin::simulation::sensors::GpsSensorParameters;
using aerodt::digital_twin::simulation::sensors::ImuSensorParameters;
using aerodt::digital_twin::simulation::sensors::NativeSensorSuite;
using aerodt::digital_twin::simulation::sensors::NativeSensorSuiteParameters;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("Native sensor assertion failed.");
  }
}

NativeSensorSuiteParameters Parameters() {
  NativeSensorSuiteParameters parameters;
  parameters.home_latitude_deg = 37.5665;
  parameters.home_longitude_deg = 126.9780;
  parameters.home_altitude_m = 38.0;
  parameters.imu.push_back(ImuSensorParameters{
      .id = "IMU1", .sample_interval = std::chrono::milliseconds(3)});
  parameters.gps.push_back(GpsSensorParameters{
      .id = "GPS", .sample_interval = std::chrono::milliseconds(100)});
  parameters.cameras.push_back(CameraSensorParameters{
      .id = "DownCamera",
      .sample_interval = std::chrono::milliseconds(20),
      .mount = {.position_body_m = {0.0, 0.0, 0.5}},
      .width_px = 400,
      .height_px = 225,
      .horizontal_fov_deg = 90.0,
      .enabled_image_types = {0, 2},
  });
  return parameters;
}

void TestSimulationTimeCadenceAndImuSpecificForce() {
  NativeSensorSuite suite(Parameters());
  VehicleState state;
  suite.Reset(state);
  state.time.elapsed = std::chrono::milliseconds(3);
  state.time.step = 1;
  state.linear_acceleration_ned_mps2 = {0.0, 0.0, 9.80665};
  auto frame = suite.Update("UAM1", state);
  if (frame.imu.size() != 1 || !frame.gps.empty() || !frame.cameras.empty() ||
      frame.imu[0].header.sequence != 1) {
    throw std::runtime_error("Sensor suite did not honor independent intervals.");
  }
  Near(frame.imu[0].specific_force_sensor_mps2.Norm(), 0.0, 1e-12,
       "free-fall specific force");

  state.time.elapsed = std::chrono::milliseconds(21);
  state.time.step = 7;
  state.linear_acceleration_ned_mps2 = {};
  frame = suite.Update("UAM1", state);
  if (frame.imu.size() != 1 || frame.cameras.size() != 1 || !frame.gps.empty()) {
    throw std::runtime_error("Camera state was not scheduled from simulation time.");
  }
  Near(frame.imu[0].specific_force_sensor_mps2.z, -9.80665, 1e-12,
       "stationary IMU specific force");
  Near(frame.cameras[0].focal_length_x_px, 200.0, 1e-12,
       "camera focal length");
  Near(frame.cameras[0].position_ned_m.z, 0.5, 1e-12,
       "camera mount position");
}

void TestGpsLocalTangentConversionAndReset() {
  NativeSensorSuite suite(Parameters());
  VehicleState state;
  suite.Reset(state);
  state.time.elapsed = std::chrono::milliseconds(102);
  state.time.step = 34;
  state.position_ned_m = {111.319490793, 0.0, -12.0};
  state.linear_velocity_ned_mps = {1.0, 2.0, 3.0};
  auto frame = suite.Update("UAM1", state);
  if (frame.gps.size() != 1 || !frame.gps[0].has_3d_fix ||
      frame.gps[0].header.sequence != 1) {
    throw std::runtime_error("GPS did not publish a 3D fix.");
  }
  Near(frame.gps[0].latitude_deg, 37.5675, 1e-9, "GPS latitude");
  Near(frame.gps[0].longitude_deg, 126.9780, 1e-12, "GPS longitude");
  Near(frame.gps[0].altitude_m, 50.0, 1e-12, "GPS altitude");

  VehicleState reset_state;
  reset_state.time.elapsed = std::chrono::seconds(10);
  suite.Reset(reset_state);
  reset_state.time.elapsed += std::chrono::milliseconds(3);
  reset_state.time.step = 1;
  const auto reset_frame = suite.Update("UAM1", reset_state);
  if (reset_frame.imu.size() != 1 || reset_frame.imu[0].header.sequence != 1) {
    throw std::runtime_error("Sensor reset did not restart its deterministic sequence.");
  }
}

}  // namespace

int main() {
  try {
    TestSimulationTimeCadenceAndImuSpecificForce();
    TestGpsLocalTangentConversionAndReset();
    std::cout << "AERODT_NATIVE_SENSORS=PASS\n";
    return 0;
  } catch (const std::exception& exception) {
    std::cerr << "AERODT_NATIVE_SENSORS=FAIL: " << exception.what() << '\n';
    return 1;
  }
}
