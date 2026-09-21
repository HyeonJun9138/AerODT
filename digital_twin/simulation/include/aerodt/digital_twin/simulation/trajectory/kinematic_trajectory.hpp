#pragma once

#include <vector>

#include "aerodt/digital_twin/contracts/vehicle_state.hpp"
#include "aerodt/foundation/math/vector3.hpp"

namespace aerodt::digital_twin::simulation::trajectory {

// One row of a scripted motion: where the object is at `time_s` on the
// simulation clock, how it is oriented and how fast it moves. Ported from
// ProjectAirSim's environment-actor trajectory (time, pose, angular pose,
// linear velocity tables).
struct TrajectorySample {
  double time_s{};
  foundation::math::Vector3 position_ned_m{};
  foundation::math::Vector3 roll_pitch_yaw_rad{};
  foundation::math::Vector3 velocity_ned_mps{};
};

// How one actor plays a shared table: shifted in time and space, optionally
// looping. The legacy `TrajectoryParams`, without the per-axis angle offsets
// nobody used.
struct TrajectoryOffsets {
  double time_s{};
  foundation::math::Vector3 position_ned_m{};
  double yaw_rad{};
  bool loop{};
};

// A motion given as a table rather than computed by physics: the flight-plan
// playback of the Simulation Engine. Between two rows every value is linearly
// interpolated (angles along the shorter arc); before the first row the
// object holds the first row, after the last it holds the last unless it
// loops. Pure: no clock, no entity, no storage.
class KinematicTrajectory final {
 public:
  explicit KinematicTrajectory(std::vector<TrajectorySample> samples,
                               TrajectoryOffsets offsets = {});

  [[nodiscard]] contracts::VehicleState StateAt(
      foundation::time::SimulationTime time) const;
  // True once the table is exhausted and not looping: the actor has nothing
  // more to say and a scheduler may retire it.
  [[nodiscard]] bool HasEnded(foundation::time::SimulationTime time) const noexcept;
  [[nodiscard]] double StartTimeS() const noexcept;
  [[nodiscard]] double EndTimeS() const noexcept;
  [[nodiscard]] const std::vector<TrajectorySample>& Samples() const noexcept;
  [[nodiscard]] const TrajectoryOffsets& Offsets() const noexcept;

 private:
  [[nodiscard]] double TableTime(foundation::time::SimulationTime time) const noexcept;

  std::vector<TrajectorySample> samples_;
  TrajectoryOffsets offsets_;
};

// Fills each row's velocity from the positions of its neighbours (central
// differences inside, one-sided at the ends), for tables that only give
// where the object is, such as a schedule of waypoint times.
[[nodiscard]] std::vector<TrajectorySample> DeriveVelocities(
    std::vector<TrajectorySample> samples);

}  // namespace aerodt::digital_twin::simulation::trajectory
