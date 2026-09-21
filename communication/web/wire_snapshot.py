"""JSON encoding for v1 wire values, without recursive deepcopy/asdict cost."""
import json

def public_value(value):
    fields=vars(value)
    return {key:item for key,item in fields.items() if key!='estimation_state'} if 'estimation_state' in fields else fields


def encode_snapshot(snapshot, capabilities, clock_rate=None):
    # Snapshot input is an injected read-only value, not a runtime dependency.
    payload = dict(vars(snapshot), capabilities=capabilities)
    if clock_rate is not None:
        payload["clock_rate"] = clock_rate
    return json.dumps(payload, default=public_value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
