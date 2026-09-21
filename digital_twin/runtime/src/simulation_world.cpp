#include "aerodt/digital_twin/runtime/simulation_world.hpp"

#include <stdexcept>
#include <utility>

namespace aerodt::digital_twin::runtime {

SimulationWorld::SimulationWorld(std::chrono::nanoseconds step) : clock_(step) {}

void SimulationWorld::RequireUniqueEntityId(const std::string& entity_id) const {
  if (entity_id.empty()) throw std::invalid_argument("Simulation entities need an entity ID.");
  for (const auto& snapshot : snapshots_) {
    if (snapshot.entity_id == entity_id) {
      throw std::invalid_argument("Simulation entity ID is already in the world: " + entity_id);
    }
  }
}

std::size_t SimulationWorld::AddVehicle(std::unique_ptr<UamVehicleRuntime> vehicle,
                                        VehicleStep step) {
  if (!vehicle || !step) {
    throw std::invalid_argument("A simulated vehicle needs a runtime and a step function.");
  }
  if (vehicle->Config().step != clock_.Step()) {
    throw std::invalid_argument("A simulated vehicle must tick on the world's clock step.");
  }
  RequireUniqueEntityId(vehicle->Config().entity_id);
  vehicles_.push_back({.runtime = std::move(vehicle), .step = std::move(step), .last_tick = {}});
  CollectSnapshots();
  return vehicles_.size() - 1;
}

std::size_t SimulationWorld::AddTrajectoryActor(TrajectoryActorRuntime actor) {
  RequireUniqueEntityId(actor.EntityId());
  actors_.push_back(std::move(actor));
  CollectSnapshots();
  return actors_.size() - 1;
}

void SimulationWorld::Reset() {
  clock_.Reset();
  for (auto& entry : vehicles_) {
    entry.runtime->Reset();
    entry.last_tick = {};
  }
  for (auto& actor : actors_) actor.Reset();
  CollectSnapshots();
}

const std::vector<contracts::StateSnapshot>& SimulationWorld::Advance() {
  const auto now = clock_.Advance();
  for (auto& entry : vehicles_) {
    entry.last_tick = entry.step(*entry.runtime);
    if (entry.last_tick.state.vehicle.time.step != now.step) {
      throw std::logic_error("A simulated vehicle fell out of step with the world clock.");
    }
  }
  for (auto& actor : actors_) actor.Advance(now);
  CollectSnapshots();
  return snapshots_;
}

// Vehicles first, then actors, in the order they were added; the vehicle
// snapshot is the last tick's when there was one, the runtime's state otherwise.
void SimulationWorld::CollectSnapshots() {
  snapshots_.clear();
  snapshots_.reserve(vehicles_.size() + actors_.size());
  for (const auto& entry : vehicles_) {
    if (entry.last_tick.state.entity_id.empty()) {
      snapshots_.push_back({.entity_id = entry.runtime->Config().entity_id,
                            .vehicle = entry.runtime->State(),
                            .is_grounded = entry.runtime->IsGrounded()});
    } else {
      snapshots_.push_back(entry.last_tick.state);
    }
  }
  for (const auto& actor : actors_) snapshots_.push_back(actor.Snapshot());
}

const SimulationClock& SimulationWorld::Clock() const noexcept { return clock_; }

std::size_t SimulationWorld::EntityCount() const noexcept {
  return vehicles_.size() + actors_.size();
}

const std::vector<contracts::StateSnapshot>& SimulationWorld::Snapshots() const noexcept {
  return snapshots_;
}

UamVehicleRuntime& SimulationWorld::Vehicle(std::size_t index) {
  return *vehicles_.at(index).runtime;
}

const UamTickResult& SimulationWorld::LastVehicleTick(std::size_t index) const {
  return vehicles_.at(index).last_tick;
}

const TrajectoryActorRuntime& SimulationWorld::TrajectoryActor(std::size_t index) const {
  return actors_.at(index);
}

std::size_t SimulationWorld::VehicleCount() const noexcept { return vehicles_.size(); }

std::size_t SimulationWorld::TrajectoryActorCount() const noexcept { return actors_.size(); }

}  // namespace aerodt::digital_twin::runtime
