"""접근 시각(EAT)과 수동 기체 우선권.

A holding pilot's complaint was not that the service had nothing to say. The
sequencer computes when they will be let in every tick and puts it on the wire;
nothing read it, and what was shown instead was how long they had already
waited. Two things follow: the time has to be issued as something that stands,
and the aircraft a person is flying should not be at the back of the queue.
"""
import pytest

from digital_twin.simulation import psu_sequencing
from digital_twin.simulation.psu_sequencing import ARRIVAL, GRANTED, HOLDING, PsuSequencer, Tuning


def sequencer(**tuning):
    tuning.setdefault('manual_arrival_priority',True)
    return PsuSequencer(stands=lambda vertiport: ["G1", "G2", "G3", "G4"], tuning=Tuning(**tuning))


# A stand each, because an arrival with nowhere to taxi to is left out of the
# booking entirely and would make every ordering test vacuous.
def arrive(psu, flight_id, now, eta, stand="G1"):
    return psu.request_arrival(flight_id=flight_id, vertiport="VP1", fato="F1",
                               stand=stand, earliest_s=eta, now_s=now)


def observed(**flights):
    return {flight: {"eta_s": eta, "remaining_s": max(0.0, eta - 0.0), "approach_ready": True,
                     "manual": manual}
            for flight, (eta, manual) in flights.items()}


# ---- the time that is issued -------------------------------------------
# Tested as the rule it is. Driving it through the forecast means arranging for
# `approach_s` to move by a particular amount, which is a test of the arithmetic
# above it rather than of what is said to the pilot.
def issued(psu, approach_s, now):
    clearance = psu_sequencing.Clearance(flight_id="F1", kind=ARRIVAL, approach_s=approach_s)
    psu._issue_approach_time(clearance, now)
    return clearance


def test_the_first_answer_is_issued_and_then_stands():
    psu = sequencer()
    clearance = issued(psu, 600.0, 0.0)
    assert clearance.eat_s == 600.0 and clearance.eat_revision == 0
    # A forecast that wobbles by a few seconds must not reissue the time: that
    # is the sliding number the pilot could not plan against.
    for wobble in (605.0, 596.0, 612.0):
        clearance.approach_s = wobble
        psu._issue_approach_time(clearance, 1.0)
        assert clearance.eat_s == 600.0, f"{wobble}"
        assert clearance.eat_revision == 0


def test_a_real_move_is_reissued_once_and_says_how_far():
    psu = sequencer()
    clearance = issued(psu, 600.0, 0.0)
    clearance.approach_s = 780.0
    psu._issue_approach_time(clearance, 2.0)
    assert clearance.eat_s == 780.0
    assert clearance.eat_revision == 1
    assert clearance.eat_moved_s == pytest.approx(180.0)
    assert clearance.eat_revised_s == 2.0
    # And it stands again rather than being reissued every tick afterwards.
    clearance.approach_s = 785.0
    psu._issue_approach_time(clearance, 3.0)
    assert clearance.eat_revision == 1
    # Coming early is a revision too, and the distance is signed so the cockpit
    # can say which way it went.
    clearance.approach_s = 600.0
    psu._issue_approach_time(clearance, 4.0)
    assert clearance.eat_revision == 2 and clearance.eat_moved_s == pytest.approx(-180.0)


def test_an_arrival_with_no_approach_time_has_none_to_show():
    psu = sequencer()
    clearance = issued(psu, 600.0, 0.0)
    clearance.approach_s = None
    psu._issue_approach_time(clearance, 10.0)
    assert clearance.eat_s is None


def test_the_issued_time_is_on_the_wire():
    # It reaches the cockpit through `as_dict`, which is every slot, so this is
    # really a check that the field exists at all -- and it is what the browser
    # reads, so a rename here is a silent blank there.
    psu = sequencer()
    arrive(psu, "F1", 0.0, 600.0)
    psu.refresh_arrivals(observed(F1=(600.0, False)), 0.0)
    answer = psu.clearance("F1", ARRIVAL).as_dict()
    for name in ("eat_s", "eat_revision", "eat_moved_s", "cleared_s", "approach_s", "sequence"):
        assert name in answer, name
    assert answer["eat_s"] is not None, "예보가 있으면 발부된 시각도 있다"


# ---- who goes first -----------------------------------------------------
def test_the_hand_flown_aircraft_books_ahead_of_waiting_automatics():
    psu = sequencer()
    # Two automatics asked first and are both still waiting.
    arrive(psu, "AUTO1", 0.0, 600.0, "G1")
    arrive(psu, "AUTO2", 1.0, 610.0, "G2")
    arrive(psu, "HAND", 2.0, 620.0, "G3")
    psu.refresh_arrivals(observed(AUTO1=(600.0, False), AUTO2=(610.0, False), HAND=(620.0, True)), 3.0)
    slots = {name: psu.clearance(name, ARRIVAL).cleared_s for name in ("AUTO1", "AUTO2", "HAND")}
    assert slots["HAND"] < slots["AUTO1"], f"수동이 먼저다: {slots}"
    assert slots["HAND"] < slots["AUTO2"]
    # Separation is untouched; nobody is squeezed, they are only reordered.
    ordered = sorted(slots.values())
    for before, after in zip(ordered, ordered[1:]):
        assert after - before >= psu.tuning.landing_separation_s - 1e-6


def test_priority_does_not_leave_the_deck_idle_for_someone_ten_minutes_out():
    # The first version of this booked the whole calendar to the hand-flown
    # aircraft, so an automatic arrival a minute from the threshold was pushed
    # behind one that had not arrived yet and the pad stood empty between them.
    # Priority is about who wins a contested slot, not about reserving the deck.
    psu = sequencer()
    arrive(psu, "AUTO1", 0.0, 120.0, "G1")
    arrive(psu, "HAND", 1.0, 600.0, "G2")
    psu.refresh_arrivals(observed(AUTO1=(120.0, False), HAND=(600.0, True)), 2.0)
    auto = psu.clearance("AUTO1", ARRIVAL).cleared_s
    hand = psu.clearance("HAND", ARRIVAL).cleared_s
    assert auto < hand, "먼저 닿을 수 있는 기체를 막지 않는다"
    assert auto < 300, f"패드를 비워두지 않는다 ({auto:.0f}s)"


def test_priority_never_displaces_an_approach_already_committed():
    psu = sequencer()
    arrive(psu, "AUTO1", 0.0, 120.0, "G1")
    arrive(psu, "HAND", 1.0, 600.0, "G2")
    observations = observed(AUTO1=(120.0, False), HAND=(600.0, True))
    psu.refresh_arrivals(observations, 2.0)
    assert psu.begin_approach("AUTO1", 3.0) is True
    psu.refresh_arrivals(observations, 4.0)
    committed = psu.clearance("AUTO1", ARRIVAL)
    hand = psu.clearance("HAND", ARRIVAL)
    assert committed.approach_started_s is not None
    assert hand.cleared_s > committed.cleared_s, "최종 접근 중인 기체는 밀지 않는다"


def test_priority_can_be_turned_off_and_then_it_is_first_come_again():
    psu = sequencer(manual_arrival_priority=False)
    arrive(psu, "AUTO1", 0.0, 600.0, "G1")
    arrive(psu, "HAND", 1.0, 610.0, "G2")
    psu.refresh_arrivals(observed(AUTO1=(600.0, False), HAND=(610.0, True)), 2.0)
    assert psu.clearance("AUTO1", ARRIVAL).cleared_s < psu.clearance("HAND", ARRIVAL).cleared_s


def test_an_aircraft_nobody_is_flying_gets_no_priority_from_a_missing_flag():
    # The engine writes `manual` on every arrival observation. An older engine
    # that does not must not be read as "everything is hand-flown".
    psu = sequencer()
    arrive(psu, "A", 0.0, 600.0, "G1")
    arrive(psu, "B", 1.0, 610.0, "G2")
    plain = {name: {"eta_s": eta, "remaining_s": eta, "approach_ready": True}
             for name, eta in (("A", 600.0), ("B", 610.0))}
    psu.refresh_arrivals(plain, 2.0)
    assert psu.clearance("A", ARRIVAL).cleared_s < psu.clearance("B", ARRIVAL).cleared_s
