#include "aerodt/digital_twin/runtime/trajectory_actor_runtime.hpp"

#include <stdexcept>
#include <utility>

namespace aerodt::digital_twin::runtime {

TrajectoryActorRuntime::TrajectoryActorRuntime(
    std::string entity_id, simulation::trajectory::KinematicTrajectory trajectory)
    : entity_id_(std::move(entity_id)), trajectory_(std::move(trajectory)) {
  if (entity_id_.empty()) {
    throw std::invalid_argument("A trajectory actor needs an entity ID.");
  }
  Reset();
}

void TrajectoryActorRuntime::Reset() {
  snapshot_ = {.entity_id = entity_id_, .vehicle = trajectory_.StateAt({}), .is_grounded = false};
}

const contracts::StateSnapshot& TrajectoryActorRuntime::Advance(
    foundation::time::SimulationTime now) {
  snapshot_.vehicle = trajectory_.StateAt(now);
  return snapshot_;
}

const std::string& TrajectoryActorRuntime::EntityId() const noexcept { return entity_id_; }

const contracts::StateSnapshot& TrajectoryActorRuntime::Snapshot() const noexcept {
  return snapshot_;
}

const simulation::trajectory::KinematicTrajectory& TrajectoryActorRuntime::Trajectory()
    const noexcept {
  return trajectory_;
}

bool TrajectoryActorRuntime::HasEnded(foundation::time::SimulationTime now) const noexcept {
  return trajectory_.HasEnded(now);
}

}  // namespace aerodt::digital_twin::runtime
