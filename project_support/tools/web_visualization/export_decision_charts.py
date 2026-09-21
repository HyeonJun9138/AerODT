"""Write the decision charts where the browser tests can read them.

The charts live in Python because that is where the decisions are. The drawing
is checked in Node. Rather than keep a second copy by hand - which would agree
for a week and then quietly stop - the copy is generated, and a test asserts it
still matches. A stale fixture fails loudly instead of testing a chart that no
longer exists.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
FIXTURE = ROOT / "project_support/tests/web_live/browser/decision_charts.json"


def content():
    from digital_twin.simulation import decision_policy
    return json.dumps(decision_policy.CHARTS, ensure_ascii=False, indent=1) + "\n"


if __name__ == "__main__":
    FIXTURE.write_text(content(), encoding="utf-8", newline="\n")
    print(f"wrote {FIXTURE.relative_to(ROOT)}")
