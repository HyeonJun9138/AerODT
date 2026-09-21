#include "aerodt/digital_twin/simulation/trajectory/kinematic_trajectory.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace aerodt::digital_twin::simulation::trajectory {
namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

double WrapAngle(double angle) {
  angle = std::fmod(angle + kTwoPi * 0.5, kTwoPi);
  if (angle < 0.0) angle += kTwoPi;
  return angle - kTwoPi * 0.5;
}

double LerpAngle(double from, double to, double fraction) {
  return WrapAngle(from + WrapAngle(to - from) * fraction);
}

foundation::math::Vector3 Lerp(const foundation::math::Vector3& from,
                               const foundation::math::Vector3& to, double fraction) {
  return from + (to - from) * fraction;
}

bool Finite(const TrajectorySample& sample) {
  return std::isfinite(sample.time_s) && sample.position_ned_m.IsFinite() &&
         sample.roll_pitch_yaw_rad.IsFinite() && sample.velocity_ned_mps.IsFinite();
}

double Seconds(foundation::time::SimulationTime time) {
  return std::chrono::duration<double>(time.elapsed).count();
}

}  // namespace

KinematicTrajectory::KinematicTrajectory(std::vector<TrajectorySample> samples,
                                         TrajectoryOffsets offsets)
    : samples_(std::move(samples)), offsets_(offsets) {
  if (samples_.empty()) {
    throw std::invalid_argument("A kinematic trajectory needs at least one sample.");
  }
  for (std::size_t index = 0; index < samples_.size(); ++index) {
    if (!Finite(samples_[index])) {
      throw std::invalid_argument("Kinematic trajectory samples must be finite.");
    }
    if (index > 0 && !(samples_[index].time_s > samples_[index - 1].time_s)) {
      throw std::invalid_argument("Kinematic trajectory times must strictly increase.");
    }
  }
  if (!std::isfinite(offsets_.time_s) || !offsets_.position_ned_m.IsFinite() ||
      !std::isfinite(offsets_.yaw_rad)) {
    throw std::invalid_argument("Kinematic trajectory offsets must be finite.");
  }
}

double KinematicTrajectory::StartTimeS() const noexcept {
  return samples_.front().time_s + offsets_.time_s;
}

double KinematicTrajectory::EndTimeS() const noexcept {
  return samples_.back().time_s + offsets_.time_s;
}

const std::vector<TrajectorySample>& KinematicTrajectory::Samples() const noexcept {
  return samples_;
}

const TrajectoryOffsets& KinematicTrajectory::Offsets() const noexcept { return offsets_; }

bool KinematicTrajectory::HasEnded(foundation::time::SimulationTime time) const noexcept {
  return !offsets_.loop && Seconds(time) > EndTimeS();
}

// The clock time mapped into the table's own time: shifted by the offset and,
// when looping, folded back into one pass of the table.
double KinematicTrajectory::TableTime(foundation::time::SimulationTime time) const noexcept {
  double table_time = Seconds(time) - offsets_.time_s;
  const double start = samples_.front().time_s, end = samples_.back().time_s;
  const double duration = end - start;
  if (offsets_.loop && duration > 0.0 && table_time > end) {
    table_time = start + std::fmod(table_time - start, duration);
  }
  return table_time;
}

contracts::VehicleState KinematicTrajectory::StateAt(
    foundation::time::SimulationTime time) const {
  const double table_time = TableTime(time);
  TrajectorySample sample;
  if (table_time <= samples_.front().time_s) {
    sample = samples_.front();
  } else if (table_time >= samples_.back().time_s) {
    sample = samples_.back();
  } else {
    // First row strictly after the time; the row before it is the lower bound.
    const auto upper = std::upper_bound(
        samples_.begin(), samples_.end(), table_time,
        [](double value, const TrajectorySample& row) { return value < row.time_s; });
    const auto& next = *upper;
    const auto& previous = *(upper - 1);
    const double fraction = (table_time - previous.time_s) / (next.time_s - previous.time_s);
    sample.time_s = table_time;
    sample.position_ned_m = Lerp(previous.position_ned_m, next.position_ned_m, fraction);
    sample.roll_pitch_yaw_rad = {
        LerpAngle(previous.roll_pitch_yaw_rad.x, next.roll_pitch_yaw_rad.x, fraction),
        LerpAngle(previous.roll_pitch_yaw_rad.y, next.roll_pitch_yaw_rad.y, fraction),
        LerpAngle(previous.roll_pitch_yaw_rad.z, next.roll_pitch_yaw_rad.z, fraction),
    };
    sample.velocity_ned_mps = Lerp(previous.velocity_ned_mps, next.velocity_ned_mps, fraction);
  }
  // Before the table begins and after it ends the object stands still even
  // if the edge row carried a velocity: it is parked, not flying.
  const bool inside = table_time > samples_.front().time_s && table_time < samples_.back().time_s;
  contracts::VehicleState state;
  state.time = time;
  state.position_ned_m = sample.position_ned_m + offsets_.position_ned_m;
  state.orientation_body_to_ned = foundation::math::Quaternion::FromRollPitchYaw(
      sample.roll_pitch_yaw_rad.x, sample.roll_pitch_yaw_rad.y,
      WrapAngle(sample.roll_pitch_yaw_rad.z + offsets_.yaw_rad));
  state.linear_velocity_ned_mps = inside ? sample.velocity_ned_mps : foundation::math::Vector3{};
  return state;
}

std::vector<TrajectorySample> DeriveVelocities(std::vector<TrajectorySample> samples) {
  const std::size_t count = samples.size();
  if (count < 2) {
    for (auto& sample : samples) sample.velocity_ned_mps = {};
    return samples;
  }
  std::vector<foundation::math::Vector3> velocities(count);
  for (std::size_t index = 0; index < count; ++index) {
    const std::size_t before = index == 0 ? 0 : index - 1;
    const std::size_t after = index + 1 == count ? index : index + 1;
    const double dt = samples[after].time_s - samples[before].time_s;
    if (!(dt > 0.0)) throw std::invalid_argument("Kinematic trajectory times must strictly increase.");
    velocities[index] = (samples[after].position_ned_m - samples[before].position_ned_m) / dt;
  }
  for (std::size_t index = 0; index < count; ++index) samples[index].velocity_ned_mps = velocities[index];
  return samples;
}

}  // namespace aerodt::digital_twin::simulation::trajectory
