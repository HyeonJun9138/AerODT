#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>

#include "aerodt/digital_twin/simulation/trajectory/kinematic_trajectory.hpp"

namespace {

using aerodt::digital_twin::simulation::trajectory::DeriveVelocities;
using aerodt::digital_twin::simulation::trajectory::KinematicTrajectory;
using aerodt::digital_twin::simulation::trajectory::TrajectoryOffsets;
using aerodt::digital_twin::simulation::trajectory::TrajectorySample;
using aerodt::foundation::time::SimulationTime;

constexpr double kPi = 3.14159265358979323846;

void Near(double actual, double expected, double tolerance, const char* label) {
  if (std::abs(actual - expected) > tolerance) {
    std::cerr << label << ": expected " << expected << ", got " << actual << '\n';
    throw std::runtime_error("Kinematic trajectory assertion failed.");
  }
}

SimulationTime At(double seconds) {
  return {.elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
              std::chrono::duration<double>(seconds)),
          .step = static_cast<std::uint64_t>(seconds * 1000.0)};
}

double Yaw(const aerodt::foundation::math::Quaternion& q) {
  return std::atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z));
}

std::vector<TrajectorySample> Climb() {
  // Sit for ten seconds, climb to -30 m over twenty, fly north 100 m in ten.
  return {
      {.time_s = 10.0, .position_ned_m = {0.0, 0.0, 0.0}, .roll_pitch_yaw_rad = {}, .velocity_ned_mps = {}},
      {.time_s = 30.0, .position_ned_m = {0.0, 0.0, -30.0}, .roll_pitch_yaw_rad = {}, .velocity_ned_mps = {0.0, 0.0, -1.5}},
      {.time_s = 40.0, .position_ned_m = {100.0, 0.0, -30.0}, .roll_pitch_yaw_rad = {0.0, 0.0, 0.0}, .velocity_ned_mps = {10.0, 0.0, 0.0}},
  };
}

void TestHoldsBeforeInterpolatesBetweenAndHoldsAfter() {
  KinematicTrajectory trajectory(Climb());
  Near(trajectory.StartTimeS(), 10.0, 1e-12, "start");
  Near(trajectory.EndTimeS(), 40.0, 1e-12, "end");

  const auto parked = trajectory.StateAt(At(2.0));
  Near(parked.position_ned_m.z, 0.0, 1e-12, "parked before the first row");
  Near(parked.linear_velocity_ned_mps.z, 0.0, 1e-12, "parked: no velocity");
  if (parked.time.step != At(2.0).step) throw std::runtime_error("State does not carry the clock time.");

  const auto halfway = trajectory.StateAt(At(20.0));
  Near(halfway.position_ned_m.z, -15.0, 1e-9, "linear position between rows");
  Near(halfway.linear_velocity_ned_mps.z, -0.75, 1e-9, "linear velocity between rows");

  const auto cruising = trajectory.StateAt(At(35.0));
  Near(cruising.position_ned_m.x, 50.0, 1e-9, "north between rows");
  Near(cruising.position_ned_m.z, -30.0, 1e-9, "level between rows");

  const auto arrived = trajectory.StateAt(At(90.0));
  Near(arrived.position_ned_m.x, 100.0, 1e-12, "held at the last row");
  Near(arrived.linear_velocity_ned_mps.x, 0.0, 1e-12, "arrived: no velocity");
  if (!trajectory.HasEnded(At(90.0)) || trajectory.HasEnded(At(39.0))) {
    throw std::runtime_error("HasEnded does not follow the last row.");
  }
}

void TestOffsetsShiftTimeSpaceAndYaw() {
  KinematicTrajectory shifted(Climb(), {.time_s = 100.0, .position_ned_m = {1000.0, 2000.0, 0.0}, .yaw_rad = kPi / 2});
  Near(shifted.StartTimeS(), 110.0, 1e-12, "start shifted");
  const auto halfway = shifted.StateAt(At(120.0));
  Near(halfway.position_ned_m.x, 1000.0, 1e-9, "east/north offset applied");
  Near(halfway.position_ned_m.y, 2000.0, 1e-9, "east/north offset applied");
  Near(halfway.position_ned_m.z, -15.0, 1e-9, "the same table, later");
  Near(Yaw(halfway.orientation_body_to_ned), kPi / 2, 1e-9, "yaw offset applied");
}

void TestAnglesInterpolateAlongTheShorterArc() {
  KinematicTrajectory turn({
      {.time_s = 0.0, .roll_pitch_yaw_rad = {0.0, 0.0, 170.0 * kPi / 180.0}},
      {.time_s = 10.0, .roll_pitch_yaw_rad = {0.0, 0.0, -170.0 * kPi / 180.0}},
  });
  const auto midway = turn.StateAt(At(5.0));
  Near(std::abs(Yaw(midway.orientation_body_to_ned)), kPi, 1e-9, "170 -> -170 passes through 180, not 0");
}

void TestLoopingRepeatsTheTable() {
  KinematicTrajectory loop(Climb(), {.loop = true});
  const auto second_pass = loop.StateAt(At(40.0 + 10.0));
  Near(second_pass.position_ned_m.z, -15.0, 1e-9, "ten seconds into the second pass");
  if (loop.HasEnded(At(1000.0))) throw std::runtime_error("A looping trajectory never ends.");
}

void TestDerivedVelocitiesFromPositions() {
  const auto derived = DeriveVelocities({
      {.time_s = 0.0, .position_ned_m = {0.0, 0.0, 0.0}},
      {.time_s = 10.0, .position_ned_m = {100.0, 0.0, 0.0}},
      {.time_s = 20.0, .position_ned_m = {100.0, 200.0, 0.0}},
  });
  Near(derived[0].velocity_ned_mps.x, 10.0, 1e-12, "one-sided at the start");
  Near(derived[1].velocity_ned_mps.x, 5.0, 1e-12, "central difference inside");
  Near(derived[1].velocity_ned_mps.y, 10.0, 1e-12, "central difference inside");
  Near(derived[2].velocity_ned_mps.y, 20.0, 1e-12, "one-sided at the end");
}

void TestRejectsBadTables() {
  const auto expect_invalid = [](auto action, const char* label) {
    try {
      action();
    } catch (const std::invalid_argument&) {
      return;
    }
    std::cerr << label << '\n';
    throw std::runtime_error("Expected an invalid_argument.");
  };
  expect_invalid([] { KinematicTrajectory({}); }, "empty table");
  expect_invalid([] { KinematicTrajectory({{.time_s = 1.0}, {.time_s = 1.0}}); }, "equal times");
  expect_invalid([] { KinematicTrajectory({{.time_s = 2.0}, {.time_s = 1.0}}); }, "decreasing times");
  expect_invalid([] { KinematicTrajectory({{.time_s = std::nan("")}}); }, "non-finite time");
  expect_invalid([] { KinematicTrajectory({{.time_s = 0.0}}, {.yaw_rad = std::nan("")}); }, "non-finite offset");
}

}  // namespace

int main() {
  try {
    TestHoldsBeforeInterpolatesBetweenAndHoldsAfter();
    TestOffsetsShiftTimeSpaceAndYaw();
    TestAnglesInterpolateAlongTheShorterArc();
    TestLoopingRepeatsTheTable();
    TestDerivedVelocitiesFromPositions();
    TestRejectsBadTables();
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
  std::cout << "AERODT_KINEMATIC_TRAJECTORY=PASS\n";
  return 0;
}
