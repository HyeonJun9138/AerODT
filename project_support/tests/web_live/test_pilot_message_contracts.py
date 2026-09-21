import json

import pytest

from communication.python.manual_runtime import ManualRuntime
from digital_twin.contracts.pilot_psu import (
    PilotPsuReport, PilotPsuRequest, PsuPilotMessage,
)
from digital_twin.contracts.pilot_vehicle import PilotGuidanceGoal, PilotVehicleCommand
from digital_twin.simulation import manual_takeover as manual
from test_manual_procedure import assigned


def test_pilot_to_psu_request_and_report_are_different_directional_contracts():
    request = PilotPsuRequest(
        message_id="pilot-1", flight_id="F1", aircraft_id="A1",
        pilot_id="P1", psu_id="PSU1", kind="takeoff",
        issued_at_s=100, sequence=1,
    )
    report = PilotPsuReport(
        message_id="pilot-2", flight_id="F1", aircraft_id="A1",
        pilot_id="P1", psu_id="PSU1", kind="report_airborne",
        issued_at_s=101, sequence=2, reference_message_id="psu-1",
    )
    assert request.as_dict()["message_type"] == "pilot_psu_request"
    assert report.as_dict()["message_type"] == "pilot_psu_report"
    assert request.as_dict()["direction"] == report.as_dict()["direction"] == "pilot_to_psu"
    with pytest.raises(ValueError):
        PilotPsuRequest(**{**request.__dict__, "kind": "report_airborne"})
    assert PilotPsuRequest.from_dict(json.loads(json.dumps(request.as_dict()))) == request
    assert PilotPsuReport.from_dict(json.loads(json.dumps(report.as_dict()))) == report


def test_manual_exchange_correlates_the_psu_message_and_is_idempotent():
    engine, _ = assigned()
    first = manual.request(engine, "A1", "departure", message_id="pilot-1", sequence=1)
    wire = first["psu_message"]
    assert wire["direction"] == "psu_to_pilot"
    assert wire["request_message_id"] == "pilot-1"
    assert wire["kind"] == "departure_response"
    before = len([event for event in engine.events if event["kind"] == "pilot_request"])
    repeated = manual.request(engine, "A1", "departure", message_id="pilot-1", sequence=1)
    assert repeated == first
    assert len([event for event in engine.events if event["kind"] == "pilot_request"]) == before
    with pytest.raises(ValueError, match="다른 내용"):
        manual.request(engine, "A1", "arrival", message_id="pilot-1", sequence=1)
    with pytest.raises(ValueError, match="순서"):
        manual.request(engine, "A1", "departure", message_id="pilot-2", sequence=1)


def test_psu_message_cannot_be_used_as_a_vehicle_command():
    message = PsuPilotMessage(
        message_id="psu-1", request_message_id="pilot-1", flight_id="F1",
        aircraft_id="A1", psu_id="PSU1", pilot_id="P1",
        kind="takeoff_clearance", outcome="granted", reason="clear",
        issued_at_s=100, expires_at_s=130, sequence=1,
    )
    assert message.as_dict()["direction"] == "psu_to_pilot"
    assert not isinstance(message, PilotVehicleCommand)
    assert PsuPilotMessage.from_dict(json.loads(json.dumps(message.as_dict()))) == message


def command(source, sequence, guidance=None):
    return PilotVehicleCommand(
        command_id=f"cmd-{sequence}", pilot_id="P1", vehicle_id="A1", flight_id="F1",
        source=source, sequence=sequence, issued_at_s=100, expires_at_s=101,
        throttle=.4, roll=0, pitch=0, yaw=0, flight_mode="fixed_wing",
        guidance=guidance,
    )


def test_manual_and_automatic_pilots_use_the_same_runtime_command_envelope():
    manual_command = command("manual", 1)
    automatic_command = command("automatic", 2, PilotGuidanceGoal(90, -200, 55))
    assert type(manual_command) is type(automatic_command) is PilotVehicleCommand
    assert manual_command.as_dict()["direction"] == "pilot_to_runtime"
    assert automatic_command.as_dict()["guidance"]["speed_mps"] == 55
    assert PilotVehicleCommand.from_dict(
        json.loads(json.dumps(automatic_command.as_dict()))) == automatic_command


def test_wire_direction_and_boolean_sequences_are_rejected():
    request = PilotPsuRequest(
        message_id="pilot-1", flight_id="F1", aircraft_id="A1",
        pilot_id="P1", psu_id="PSU1", kind="takeoff",
        issued_at_s=100, sequence=1,
    ).as_dict()
    request["direction"] = "psu_to_pilot"
    with pytest.raises(ValueError, match="direction"):
        PilotPsuRequest.from_dict(request)
    with pytest.raises(ValueError, match="sequence"):
        PilotVehicleCommand(
            command_id="cmd", pilot_id="P1", vehicle_id="A1", source="manual",
            sequence=True, issued_at_s=1, expires_at_s=2, throttle=0,
            roll=0, pitch=0, yaw=0, flight_mode="multirotor",
        )
    with pytest.raises(ValueError, match="sequence"):
        PilotPsuRequest(
            message_id="pilot-2", flight_id="F1", aircraft_id="A1",
            pilot_id="P1", psu_id="PSU1", kind="takeoff",
            issued_at_s=100, sequence=1.5,
        )


def test_runtime_adapter_translates_the_typed_pilot_command_only_at_its_boundary():
    class Runtime:
        def guidance(self, *values):
            self.guidance_values = values

        def step(self, *values, **named):
            self.step_values = values, named
            return ["state"]

    runtime = Runtime()
    automatic = command("automatic", 1, PilotGuidanceGoal(120, -80, 44))
    assert ManualRuntime.apply_pilot_command(runtime, automatic, 7) == ["state"]
    assert runtime.guidance_values == (True, 120, -80, 44)
    assert runtime.step_values == ((.4, 0, 0, True, 7), {"yaw": 0})
    with pytest.raises(TypeError):
        ManualRuntime.apply_pilot_command(runtime, {"throttle": .4}, 7)
