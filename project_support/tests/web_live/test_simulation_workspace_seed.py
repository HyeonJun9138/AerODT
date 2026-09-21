from data.simulation.workspace_seed import seed_simulation_workspace


def test_seed_installs_missing_inputs_and_preserves_operator_files(tmp_path):
    seed = tmp_path / "seed"
    workspace = tmp_path / "workspace"
    (seed / "examples").mkdir(parents=True)
    (seed / "vertiports.json").write_text('{"vertiports": []}', encoding="utf-8")
    (seed / "routes.json").write_text('{"nodes": [], "links": []}', encoding="utf-8")
    (seed / "examples/fpl_all.csv").write_text("flight_plan_id\nFPL1\n", encoding="utf-8")

    installed = seed_simulation_workspace(workspace, seed)

    assert installed == ["vertiports.json", "routes.json", "examples/fpl_all.csv"]
    routes = workspace / "simulation/routes.json"
    routes.write_text("operator edit", encoding="utf-8")
    assert seed_simulation_workspace(workspace, seed) == []
    assert routes.read_text(encoding="utf-8") == "operator edit"
