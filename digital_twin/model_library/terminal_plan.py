"""What is on the terminal floor: the way in, screening, lounges, shops, board.

The storey itself is derived in `vertiport_layout._terminal` -- the deck's own
outline set in, with the head house beside each charger as the way up. This is
the fit-out of that floor, and it is derived the same way: from the outline, the
cores that are already there, and the heading the building is turned to. No
dimension of a vertiport is decided here.

The plan follows from one fact about the geometry. The gates are spread across
the deck, so the cores that reach them are spread across the floor -- at 여의도
they run from (-75, 31) to (39, -58) through the middle of a 182 x 128 m floor.
A screening line drawn across the floor would therefore leave some gates on the
landside of it, which is wrong. So screening is at the **way in**: you come up
from the street lobby into an entry hall, go through the lanes there, and
everything beyond is airside -- gates, shops, restaurants and all. That is also
how a real terminal is arranged once its retail sits after security.

Everything is emitted as explicit corner rings in local metres. A rectangle and
a rotation is two things to get wrong and one of them is invisible; four corners
are what gets drawn, what gets walked into, and what gets tested.
"""
import math

# Retail. The frontage is a shop you walk past, the depth is one that reaches
# back to the wall without eating the concourse.
UNIT_FRONT_M = 9.0
UNIT_DEPTH_M = 10.0
# How many, as a function of how many gates there are. A 620 m perimeter would
# take fifty units at a commercial pitch, which is a shopping centre with a
# vertiport attached; this keeps it to a concourse with shops along it.
UNITS_PER_GATE, UNITS_MIN, UNITS_MAX = 2, 4, 18
UNIT_KINDS = ("mart", "shop", "cafe", "shop", "restaurant", "shop", "toilet", "shop", "cafe", "restaurant")
UNIT_NAMES = {"mart": "마트", "shop": "상점", "cafe": "카페", "restaurant": "식당", "toilet": "화장실"}

# The way in from the street lobby below: the core you arrive out of, and the
# hall it opens into, which is the only landside room on this floor.
ENTRY_CORE_M = (6.0, 6.0)
ENTRY_HALL_M = (34.0, 20.0)

# Screening, across the far side of that hall. One lane per four gates, never
# fewer than two, because one lane is a queue rather than a checkpoint.
LANE_M = (1.7, 6.5)
LANE_PITCH_M = 3.4
GATES_PER_LANE = 4

# A gate lounge. The aircraft seats four to six, so a lounge is small and that
# is honest to the vehicle rather than a terminal-sized hall nobody fills.
LOUNGE_ROWS, LOUNGE_SEATS = 2, 5
SEAT_PITCH_M, ROW_PITCH_M = 0.66, 2.3
SEAT_M = (0.56, 0.60)
LOUNGE_STANDOFF_M = 1.4

# Concourse seating, on the floor's own grid. The pitch is what leaves a
# walkable concourse rather than a waiting room, and the count is capped so a
# 23,000 m2 floor does not become three hundred benches.
REST_PITCH_M, REST_SPREAD_M = 26.0, 15.0
REST_PER_GATE, REST_MAX = 2, 16

# The departures board, facing back at the hall you arrive in.
BOARD_M = (7.2, 2.6)

# Nothing is placed within this of a stair core or of anything already placed.
CLEARANCE_M = 1.2
CORE_CLEAR_M = 4.0


def _unit(vector):
    length = math.hypot(vector[0], vector[1])
    return (vector[0] / length, vector[1] / length) if length > 1e-9 else (1.0, 0.0)


def _winding(ring):
    area = sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1]
               for i in range(len(ring)))
    return 1.0 if area > 0 else -1.0


def _contains(ring):
    """Point-in-ring for one fixed ring, by crossing count."""
    def inside(point):
        x, y = point[0], point[1]
        hit = False
        for i in range(len(ring)):
            (xi, yi), (xj, yj) = ring[i], ring[i - 1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                hit = not hit
        return hit
    return inside


def _rect(centre, along, size):
    """Four corners of a rectangle: `size` is (along, across) in metres."""
    across = (-along[1], along[0])
    half = (size[0] / 2, size[1] / 2)
    return [[round(centre[0] + along[0] * sx * half[0] + across[0] * sy * half[1], 3),
             round(centre[1] + along[1] * sx * half[0] + across[1] * sy * half[1], 3)]
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def _thick(run, width):
    """A two-point run as a ring of that width, for something to walk into."""
    along = _unit((run[1][0] - run[0][0], run[1][1] - run[0][1]))
    across = (-along[1] * width / 2, along[0] * width / 2)
    return [[round(run[0][0] + across[0], 3), round(run[0][1] + across[1], 3)],
            [round(run[1][0] + across[0], 3), round(run[1][1] + across[1], 3)],
            [round(run[1][0] - across[0], 3), round(run[1][1] - across[1], 3)],
            [round(run[0][0] - across[0], 3), round(run[0][1] - across[1], 3)]]


def _axes(ring):
    """Axes of a convex ring: along its longest wall, and square to it."""
    best, along = 0.0, (1.0, 0.0)
    for index in range(len(ring)):
        here, next_point = ring[index], ring[(index + 1) % len(ring)]
        length = math.dist(here, next_point)
        if length > best:
            best = length
            along = _unit((next_point[0] - here[0], next_point[1] - here[1]))
    return along, (-along[1], along[0])


def _overlap(first, second, gap=0.0):
    """Whether two convex rings meet, by separating axis, with a gap allowance."""
    for ring in (first, second):
        for index in range(len(ring)):
            here, next_point = ring[index], ring[(index + 1) % len(ring)]
            axis = _unit((-(next_point[1] - here[1]), next_point[0] - here[0]))
            spans = []
            for other in (first, second):
                reach = [axis[0] * point[0] + axis[1] * point[1] for point in other]
                spans.append((min(reach), max(reach)))
            if spans[0][1] + gap <= spans[1][0] or spans[1][1] + gap <= spans[0][0]:
                return False
    return True


def _spot(inside, taken, candidate, gap=CLEARANCE_M):
    """Whether a ring fits here: on the floor, and clear of everything placed."""
    if not all(inside(point) for point in candidate):
        return False
    return not any(_overlap(candidate, other, gap) for other in taken)


def _entrance(ring, heading_deg):
    """The wall the street doors are in, as the base storey below already reads it.

    `vertiport_base.entranceOf` puts them in the middle of the design frame's
    south side, turned with the building. Taking the same side here means the
    way up arrives above the way in, rather than at the back of the building.
    """
    angle = math.radians(float(heading_deg or 0.0))
    out = (-math.sin(angle) + 0.0, -math.cos(angle) + 0.0)
    reach = [point[0] * out[0] + point[1] * out[1] for point in ring]
    far = max(reach)
    front = [point for point, value in zip(ring, reach) if value >= far - 0.5]
    middle = [sum(point[0] for point in front) / len(front),
              sum(point[1] for point in front) / len(front)]
    inside = far - (middle[0] * out[0] + middle[1] * out[1])
    return out, [middle[0] + out[0] * inside, middle[1] + out[1] * inside]


def _entry(ring, inside, taken, heading_deg):
    """The hall you arrive in, and the core you arrive out of."""
    out, wall = _entrance(ring, heading_deg)
    inward = (-out[0], -out[1])
    along = (-out[1], out[0])
    hall = None
    # Slid back from the wall, and along it, until the whole hall is on the
    # floor and clear of the stairs. Both are needed. The corners of a turned
    # floor cut in, so a hall centred on the wall midpoint can have a corner
    # outside it; and the cores are scattered across the whole floor, so at the
    # real 여의도 a stair stands twelve metres from the middle of the front wall
    # and every position straight back from it is taken.
    sizes = (ENTRY_HALL_M, (ENTRY_HALL_M[0] * 0.7, ENTRY_HALL_M[1] * 0.8))
    for size in sizes:
        for slide in (0, 14, -14, 28, -28, 44, -44, 62, -62):
            for step in (1.0, 4.0, 9.0, 16.0, 26.0):
                back = size[1] / 2 + step
                centre = [wall[0] + inward[0] * back + along[0] * slide,
                          wall[1] + inward[1] * back + along[1] * slide]
                candidate = _rect(centre, along, size)
                if _spot(inside, taken, candidate, 0.0):
                    hall = {"center_m": [round(value, 3) for value in centre], "outline_m": candidate,
                            "size_m": [round(size[0], 3), round(size[1], 3)]}
                    break
            if hall:
                break
        if hall:
            break
    if hall is None:
        return None
    centre, depth = hall["center_m"], hall["size_m"][1]
    core = [centre[0] + out[0] * (depth / 2 - ENTRY_CORE_M[1] / 2 - 0.4),
            centre[1] + out[1] * (depth / 2 - ENTRY_CORE_M[1] / 2 - 0.4)]
    hall["core_m"] = [round(value, 3) for value in core]
    hall["core_outline_m"] = _rect(core, along, ENTRY_CORE_M)
    # Which way a person faces walking out of the hall into the terminal.
    hall["facing_m"] = [round(inward[0], 6), round(inward[1], 6)]
    return hall


def _security(hall, gates):
    """The screening lanes across the inner edge of the entry hall."""
    inward = hall["facing_m"]
    along = (-inward[1], inward[0])
    lanes = max(2, math.ceil(gates / GATES_PER_LANE))
    centre, size = hall["center_m"], hall["size_m"]
    seat = [centre[0] + inward[0] * (size[1] / 2 - LANE_M[1] / 2 - 0.6),
            centre[1] + inward[1] * (size[1] / 2 - LANE_M[1] / 2 - 0.6)]
    out = []
    for index in range(lanes):
        offset = (index - (lanes - 1) / 2) * LANE_PITCH_M
        middle = [seat[0] + along[0] * offset, seat[1] + along[1] * offset]
        out.append({"id": f"S{index + 1}", "center_m": [round(value, 3) for value in middle],
                    "outline_m": _rect(middle, inward, (LANE_M[1], LANE_M[0]))})
    # The wall the lanes are cut into: from the hall's edge to the first lane,
    # between the lanes, and out to the other edge. Nobody walks round a
    # checkpoint that only exists where the machines are.
    half = size[0] / 2
    edges = [-half]
    for lane in out:
        offset = ((lane["center_m"][0] - seat[0]) * along[0] + (lane["center_m"][1] - seat[1]) * along[1])
        edges += [offset - LANE_M[0] / 2, offset + LANE_M[0] / 2]
    edges.append(half)
    runs = []
    for start, end in zip(edges[0::2], edges[1::2]):
        if end - start < 0.2:
            continue
        runs.append([[round(seat[0] + along[0] * start, 3), round(seat[1] + along[1] * start, 3)],
                     [round(seat[0] + along[0] * end, 3), round(seat[1] + along[1] * end, 3)]])
    return {"lanes": out, "runs_m": runs,
            "line_m": [[round(seat[0] + along[0] * -half, 3), round(seat[1] + along[1] * -half, 3)],
                       [round(seat[0] + along[0] * half, 3), round(seat[1] + along[1] * half, 3)]]}


def _lounges(inside, taken, cores, middle):
    """A block of seats at each core, facing the way up to its gate."""
    out = []
    width = LOUNGE_SEATS * SEAT_PITCH_M
    depth = (LOUNGE_ROWS - 1) * ROW_PITCH_M + SEAT_M[1]
    for core in cores:
        centre = core["center_m"]
        inland = _unit((middle[0] - centre[0], middle[1] - centre[1]))
        half = math.hypot(*core["size_m"]) / 2
        seat = None
        # Facing the middle of the floor first, so a passenger sits looking at
        # the stair they will be called to. Where the cores cluster -- and at
        # 여의도 two of them are twelve metres apart -- the near side is taken,
        # so the lounge goes round its own core rather than not existing.
        for turn in (0, 45, -45, 90, -90, 135, -135, 180):
            angle = math.radians(turn)
            toward = (inland[0] * math.cos(angle) - inland[1] * math.sin(angle),
                      inland[0] * math.sin(angle) + inland[1] * math.cos(angle))
            along = (-toward[1], toward[0])
            for step in (0, 1, 2):
                back = half + LOUNGE_STANDOFF_M + depth / 2 + step * (depth + 1.0)
                middle_of = [centre[0] + toward[0] * back, centre[1] + toward[1] * back]
                candidate = _rect(middle_of, along, (width, depth))
                if _spot(inside, taken, candidate):
                    seat = (middle_of, candidate, toward, along)
                    break
            if seat:
                break
        if seat is None:
            continue
        middle_of, candidate, toward, along = seat
        rows = []
        for row in range(LOUNGE_ROWS):
            offset = (row - (LOUNGE_ROWS - 1) / 2) * ROW_PITCH_M
            bench = [middle_of[0] + toward[0] * offset, middle_of[1] + toward[1] * offset]
            seats = []
            for place in range(LOUNGE_SEATS):
                across = (place - (LOUNGE_SEATS - 1) / 2) * SEAT_PITCH_M
                seats.append([round(bench[0] + along[0] * across, 3), round(bench[1] + along[1] * across, 3)])
            rows.append({"outline_m": _rect(bench, along, (width, SEAT_M[1])), "seats_m": seats,
                         # Everyone on a bench faces the stair, not each other.
                         "facing_m": [round(-toward[0], 6), round(-toward[1], 6)]})
        taken.append(candidate)
        out.append({"id": f"L{core['id'][1:]}", "gate": core["gate"], "core": core["id"],
                    "center_m": [round(value, 3) for value in middle_of], "outline_m": candidate,
                    "rows": rows, "seats": LOUNGE_ROWS * LOUNGE_SEATS})
    return out


def _units(ring, inside, taken, count):
    """Shops, places to eat and the toilets, set back against the walls.

    Spaced evenly round the perimeter by walked distance rather than crammed
    along it: what makes a concourse read is passing a shop every so often, and
    a wall of frontage would leave no wall.
    """
    lengths = [math.dist(ring[i], ring[(i + 1) % len(ring)]) for i in range(len(ring))]
    perimeter = sum(lengths)
    if not (perimeter > 0) or count < 1:
        return []
    turn = _winding(ring)

    def on_wall(walked):
        """Where `walked` metres round the perimeter is, and which way the wall runs."""
        offset, edge = walked % perimeter, 0
        while edge < len(lengths) - 1 and offset > lengths[edge]:
            offset -= lengths[edge]
            edge += 1
        here, next_point = ring[edge], ring[(edge + 1) % len(ring)]
        along = _unit((next_point[0] - here[0], next_point[1] - here[1]))
        return [here[0] + along[0] * offset, here[1] + along[1] * offset], along

    out = []
    for index in range(count):
        kind = UNIT_KINDS[index % len(UNIT_KINDS)]
        # A restaurant and a mart are rooms, not kiosks -- but a smaller one is
        # still a restaurant, and a port with no place to eat because the big
        # footprint never fitted is worse than a modest one that did.
        wide = UNIT_FRONT_M * (1.6 if kind in ("mart", "restaurant") else 1.0)
        placed = None
        # Slide along the wall before giving up. A unit lands on a corner of a
        # turned floor, or on the clear zone round a stair, often enough that
        # refusing it there loses a third of the concourse.
        for size in ((wide, UNIT_DEPTH_M), (UNIT_FRONT_M, UNIT_DEPTH_M)):
            for slide in (0, 5, -5, 11, -11, 18, -18, 26, -26):
                wall, along = on_wall(perimeter * (index + 0.5) / count + slide)
                inward = (-along[1] * turn, along[0] * turn)
                for depth in (size[1] / 2 + 0.3, size[1] / 2 + 2.2, size[1] / 2 + 5.5):
                    centre = [wall[0] + inward[0] * depth, wall[1] + inward[1] * depth]
                    candidate = _rect(centre, along, size)
                    if _spot(inside, taken, candidate):
                        placed = (centre, candidate, inward, size)
                        break
                if placed:
                    break
            if placed:
                break
        if placed is None:
            continue
        centre, candidate, inward, size = placed
        taken.append(candidate)
        out.append({"id": f"U{len(out) + 1}", "kind": kind,
                    "name": f"{UNIT_NAMES[kind]} {len(out) + 1}", "center_m": [round(v, 3) for v in centre],
                    "outline_m": candidate, "size_m": [round(size[0], 3), round(size[1], 3)],
                    # The face people walk up to.
                    "facing_m": [round(-inward[0], 6), round(-inward[1], 6)]})
    return out


def _rest(ring, inside, taken, middle, limit):
    """Somewhere to sit that is not a gate lounge.

    A 23,000 m2 floor with eight small lounges round its edge is 180 m of
    nothing down the middle. These are the benches in the concourse itself,
    laid on the floor's own grid and placed only where there is already room --
    so they fill the space that is left rather than deciding what is where.
    """
    along, across = _axes(ring)
    reach = [((point[0] - middle[0]) * along[0] + (point[1] - middle[1]) * along[1],
              (point[0] - middle[0]) * across[0] + (point[1] - middle[1]) * across[1]) for point in ring]
    span = (max(v[0] for v in reach), max(v[1] for v in reach))
    width = LOUNGE_SEATS * SEAT_PITCH_M
    out = []
    steps = [0.0]
    while steps[-1] < span[0]:
        steps.append(steps[-1] + REST_PITCH_M)
    for down in [value * sign for value in steps for sign in ((1, -1) if value else (1,))]:
        for side in (0.0, REST_SPREAD_M, -REST_SPREAD_M):
            if len(out) >= limit:
                return out
            seat = [middle[0] + along[0] * down + across[0] * side,
                    middle[1] + along[1] * down + across[1] * side]
            # Back to back, because a bench people sit on from one side only is
            # half a bench and twice the floor.
            pair = _rect(seat, along, (width, SEAT_M[1] * 2 + 0.12))
            if not _spot(inside, taken, pair, CLEARANCE_M * 2):
                continue
            taken.append(pair)
            rows = []
            for face in (1, -1):
                bench = [seat[0] + across[0] * face * (SEAT_M[1] + 0.06) / 2,
                         seat[1] + across[1] * face * (SEAT_M[1] + 0.06) / 2]
                seats = [[round(bench[0] + along[0] * (place - (LOUNGE_SEATS - 1) / 2) * SEAT_PITCH_M, 3),
                          round(bench[1] + along[1] * (place - (LOUNGE_SEATS - 1) / 2) * SEAT_PITCH_M, 3)]
                         for place in range(LOUNGE_SEATS)]
                rows.append({"outline_m": _rect(bench, along, (width, SEAT_M[1])), "seats_m": seats,
                             "facing_m": [round(across[0] * face, 6), round(across[1] * face, 6)]})
            out.append({"id": f"R{len(out) + 1}", "center_m": [round(value, 3) for value in seat],
                        "outline_m": pair, "rows": rows, "seats": LOUNGE_SEATS * 2})
    return out


def _board(hall, inside, taken):
    """The departures board, hung where somebody clearing screening looks up."""
    inward = hall["facing_m"]
    along = (-inward[1], inward[0])
    centre, depth = hall["center_m"], hall["size_m"][1]
    for ahead in (depth / 2 + 7.0, depth / 2 + 12.0, depth / 2 + 18.0):
        seat = [centre[0] + inward[0] * ahead, centre[1] + inward[1] * ahead]
        candidate = _rect(seat, along, (BOARD_M[0], 0.5))
        if _spot(inside, taken, candidate):
            taken.append(candidate)
            return {"center_m": [round(value, 3) for value in seat], "outline_m": candidate,
                    "size_m": [BOARD_M[0], BOARD_M[1]],
                    # It reads back towards the way in, which is where a
                    # passenger is standing when they need it.
                    "facing_m": [round(-inward[0], 6), round(-inward[1], 6)]}
    return None


def plan(outline_m, cores, heading_deg):
    """The fit-out of one terminal floor, or None when there is no room for one."""
    ring = [list(point) for point in (outline_m or [])]
    if len(ring) < 3:
        return None
    inside = _contains(ring)
    middle = [sum(point[0] for point in ring) / len(ring), sum(point[1] for point in ring) / len(ring)]
    along, _ = _axes(ring)
    # The cores are already standing, and they are kept clear of twice over. A
    # shop is held well back, because the space round a stair is where people
    # queue; a lounge is not, because it belongs against the stair it serves --
    # holding it back by the same margin is what made every gate lounge
    # impossible, each one refused by its own core.
    shafts = [_rect(core["center_m"], along, (max(core["size_m"]) + 0.8,) * 2) for core in cores]
    reserved = [_rect(core["center_m"], along, (max(core["size_m"]) + CORE_CLEAR_M,) * 2) for core in cores]
    hall = _entry(ring, inside, reserved, heading_deg)
    if hall is None:
        return None
    security = _security(hall, len(cores))
    # Lounges first and against their own stairs; everything else then fits
    # round what is already there, which is the order a terminal is planned in.
    seated = list(shafts) + [hall["outline_m"]]
    lounges = _lounges(inside, seated, cores, middle)
    taken = list(reserved) + [hall["outline_m"]] + [lounge["outline_m"] for lounge in lounges]
    board = _board(hall, inside, taken)
    count = max(UNITS_MIN, min(UNITS_MAX, len(cores) * UNITS_PER_GATE))
    units = _units(ring, inside, taken, count)
    rest = _rest(ring, inside, taken, middle, min(REST_MAX, max(2, len(cores) * REST_PER_GATE)))
    return {"entry": hall, "security": security, "lounges": lounges, "units": units, "board": board,
            "rest": rest,
            # Every ring on the floor a person cannot walk through. The cores
            # are not here: they are the way between floors, and a walker has
            # to be able to step into one. The screening wall is, with the
            # lanes left out of it, so the way through is the way through.
            "blocks_m": [item["outline_m"] for item in units]
                        + [row["outline_m"] for lounge in lounges + rest for row in lounge["rows"]]
                        + [_thick(run, 0.34) for run in security["runs_m"]]
                        + [hall["core_outline_m"]] + ([board["outline_m"]] if board else []),
            "cores_reserved": len(reserved),
            "note": "Derived terminal fit-out; representative, not a surveyed design."}
