import json
from communication.web.wire_snapshot import encode_snapshot
from digital_twin.contracts.live import Snapshot


def test_wire_encoding_is_versioned_and_has_no_python_objects():
    encoded = encode_snapshot(Snapshot(1, 42, 123.5, (), ()), {'situation_assessment': False})
    assert isinstance(encoded, str)
    # `epoch` says which run of the twin's clock this belongs to. State time only
    # rises within one, so a display that sees a new epoch re-anchors instead of
    # rejecting an earlier instant the operator asked to look at.
    assert json.loads(encoded) == dict(schema_version=1, sequence=42, state_time=123.5,
        entities=[], sources=[], epoch=0, capabilities={'situation_assessment': False})
    moved = json.loads(encode_snapshot(Snapshot(1, 43, 99.0, (), (), 1), {}))
    assert moved['epoch'] == 1 and moved['state_time'] == 99.0
    accelerated = json.loads(encode_snapshot(Snapshot(1, 44, 100.0, (), (), 1), {}, 10))
    assert accelerated['clock_rate'] == 10
