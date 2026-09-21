"""Install versioned simulation examples into an empty local workspace."""

import os
from pathlib import Path


SIMULATION_SEED_FILES = (
    Path("vertiports.json"),
    Path("routes.json"),
    Path("examples/fpl_all.csv"),
)


def seed_simulation_workspace(workspace_directory, seed_directory):
    """Copy missing durable inputs without overwriting operator edits."""
    workspace = Path(workspace_directory) / "simulation"
    seed = Path(seed_directory)
    installed = []
    for relative in SIMULATION_SEED_FILES:
        source = seed / relative
        target = workspace / relative
        if target.exists() or not source.is_file():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        pending = target.with_name(target.name + ".seeding")
        try:
            pending.write_bytes(source.read_bytes())
            os.replace(pending, target)
        finally:
            pending.unlink(missing_ok=True)
        installed.append(relative.as_posix())
    return installed
