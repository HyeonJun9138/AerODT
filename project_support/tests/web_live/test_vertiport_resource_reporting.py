import json

import pytest

from digital_twin.contracts.vertiport_resources import VertiportResourceReport
from digital_twin.simulation.psu_sequencing import PsuSequencer
from user_application.uam_mission.vertiport_operator import VertiportOperators
from digital_twin.simulation.scenario_engine import ScenarioEngine
from test_scenario_engine import NETWORK, VERTIPORTS, row, schedule_of


PORTS = [
    {"id": "VP1", "layout": {
        "fatos": [{"id": "F1"}],
        "gates": [{"id": "G1"}, {"id": "G2"}],
        "chargers": [{"id": "C1", "gate": "G1"}],
    }},
    {"id": "VP2", "layout": {
        "fatos": [{"id": "F1"}],
        "gates": [{"id": "G1"}],
    }},
]


def connected():
    operators = VertiportOperators(PORTS, report_ttl_s=10)
    psu = PsuSequencer(stands=lambda port: operators.resource_ids(port, "stand"))
    psu.attach_vertiports(operators, now_s=100)
    return operators, psu


def test_each_operator_emits_a_versioned_icd_report_that_round_trips():
    operators, psu = connected()
    report = operators.observe_occupancy("VP1", "fato", "F1", "FLIGHT-1", now_s=101)
    wire = json.loads(json.dumps(report.as_dict()))
    restored = VertiportResourceReport.from_dict(wire)
    assert restored == report
    assert restored.vertiport_id == "VP1"
    assert restored.resource("fato", "F1").occupant_id == "FLIGHT-1"
    assert psu.fato_occupants(101) == {("VP1", "F1"): "FLIGHT-1"}


def test_psu_stand_decisions_are_reads_of_the_operator_report():
    operators, psu = connected()
    operators.observe_occupancy("VP1", "stand", "G1", "AIRCRAFT-1", now_s=102)
    clearance = psu.request_arrival(
        flight_id="F2", vertiport="VP1", fato="F1", stand="G1",
        earliest_s=200, now_s=102,
    )
    assert clearance.stand == "G2"
    assert psu._stands.occupant("VP1", "G1") == "AIRCRAFT-1"
    assert psu._stands.reservation("VP1", "G2") == "F2"
    assert operators.operator("VP1").report(103).resource("stand", "G2").reservation_id == "F2"


def test_closed_and_stale_resources_are_not_assumed_free():
    operators, psu = connected()
    operators.set_operational_state("VP1", "stand", "G1", "closed", now_s=104)
    assert not psu._stands.free("VP1", "G1", "F")
    assert psu._stands.free("VP1", "G2", "F")
    assert not psu.resource_monitor.usable("VP1", "stand", "G2", "F", now_s=115)
    psu.resource_monitor.advance(115)
    assert not psu._stands.free("VP1", "G2", "F")


def test_one_vertiport_cannot_change_another_vertiports_resource():
    operators, _ = connected()
    with pytest.raises(KeyError):
        operators.operator("VP1").observe_occupancy("stand", "VP2:G1", "AIRCRAFT")
    assert operators.operator("VP2").report(105).resource("stand", "G1").occupant_id is None


def test_operator_rejects_a_reservation_based_on_an_obsolete_resource_revision():
    operators, psu = connected()
    seen = psu.resource_monitor.resource("VP1", "stand", "G1")
    operators.observe_occupancy("VP1", "stand", "G1", "AIRCRAFT", now_s=101)
    with pytest.raises(ValueError, match="revision"):
        operators.reserve("VP1", "stand", "G1", "F1", expected_revision=seen.revision, now_s=101)


def test_scenario_observation_reaches_psu_only_through_the_operator_report():
    operators = VertiportOperators(VERTIPORTS)
    engine = ScenarioEngine(
        schedule_of(row("F1", "A1", "VP1", "VP2", "06:31:00")),
        vertiports=VERTIPORTS, network=NETWORK, vertiport_operators=operators,
    )
    try:
        initial = engine.psu.resource_monitor.report("VP1", engine.time_s)
        assert initial.resource("stand", "G1").occupant_id == "A1"
        engine._active_pads[("VP1", "F1")] = "F1"
        observed = engine.psu.resource_monitor.report("VP1", engine.time_s)
        assert observed.resource("fato", "F1").occupant_id == "F1"
        assert engine.psu.fato_occupants(engine.time_s) == {("VP1", "F1"): "F1"}
    finally:
        engine.close()


def test_operator_fato_closure_holds_departure_until_a_new_report_reopens_it():
    operators = VertiportOperators(VERTIPORTS)
    engine = ScenarioEngine(
        schedule_of(row("F1", "A1", "VP1", "VP2", "06:30:00")),
        vertiports=VERTIPORTS, network=NETWORK, vertiport_operators=operators,
    )
    try:
        operators.set_operational_state("VP1", "fato", "F1", "closed", now_s=engine.time_s)
        engine.advance(engine.time_s + 1)
        aircraft = engine.aircraft["A1"]
        assert aircraft.phase == "parked"
        assert aircraft.instruction["action"] == "departure_wait"
        assert "FATO 사용 불가" in aircraft.instruction["reason"]

        operators.set_operational_state("VP1", "fato", "F1", "available", now_s=engine.time_s)
        engine.advance(engine.time_s + 1)
        assert aircraft.phase != "parked"
    finally:
        engine.close()
