"""How a tiltrotor is flying right now: on its rotors, through the transition,
or on the wing.

One number decides it — where the rotors point. The plan says where they point
through each stage, and a pilot that is actually flying reports where they are;
reading the same number in both cases means a stage nobody thought to name still
lands in the right mode, and a mode never disagrees with the tilt on screen.

The thresholds are the shape of the flight, not a controller setting: a lift off
the pad is flown on the rotors, a cruise is flown on the wing, and everything
between the two is the transition. The vocabulary is here rather than in the
simulation because the panel, the plan and the engine must all use one.
"""

ROTOR, TRANSITION, WING, GROUND = "multirotor", "transition", "fixed_wing", "ground"
MODES = (GROUND, ROTOR, TRANSITION, WING)
LABELS = {GROUND: "지상", ROTOR: "멀티로터", TRANSITION: "모드 전환 (천이)", WING: "고정익"}

# Where the rotors have to point for the mode to have changed. Below the first
# the wing is doing nothing; above the second the rotors are.
ROTOR_TILT_DEG = 15.0
WING_TILT_DEG = 75.0

# Standing on a deck is not a flight mode. These are the stages where the
# aircraft is on its wheels, whatever its rotors are doing.
GROUND_STAGES = ("parked", "gate_out", "gate_in", "charge", "boarding", "alighting")

# Where each airborne stage points its rotors, for a flight nobody is measuring.
# The pairs are the plan's own (flight_plan.AIR_STAGES and the vertical legs);
# a hold is flown after the reverse transition, so it is on the rotors.
STAGE_TILT = {
    "takeoff": (0.0, 0.0), "climb": (0.0, 90.0), "cruise": (90.0, 90.0),
    "descent": (90.0, 0.0), "hold_exit": (0.0, 0.0), "hold": (0.0, 0.0),
    "hold_return": (0.0, 0.0), "landing": (0.0, 0.0),
}


def tilt_for(stage, share=1.0):
    """Where the rotors point this far through a stage, when nobody measured it.

    `share` is 0 at the start of the stage and 1 at its end. A stage this does
    not know is flown on the rotors, which is the safe reading: it is the mode
    an aircraft can hold anywhere.
    """
    start, end = STAGE_TILT.get(stage, (0.0, 0.0))
    try:
        share = min(1.0, max(0.0, float(share)))
    except (TypeError, ValueError):
        share = 1.0
    return start + (end - start) * share


def mode_of(stage, tilt_deg=None, share=1.0):
    """The mode a stage is flown in, from the tilt when there is one.

    Given a measured tilt it is that tilt that decides, so what the panel says
    and what the model on screen is doing cannot come apart. Without one the
    plan's tilt for the stage stands in.
    """
    if stage in GROUND_STAGES or stage is None:
        return GROUND
    if tilt_deg is None or not isinstance(tilt_deg, (int, float)) or tilt_deg != tilt_deg:
        tilt_deg = tilt_for(stage, share)
    if tilt_deg >= WING_TILT_DEG:
        return WING
    if tilt_deg <= ROTOR_TILT_DEG:
        return ROTOR
    return TRANSITION


def label(mode):
    return LABELS.get(mode, mode or "정보 없음")
