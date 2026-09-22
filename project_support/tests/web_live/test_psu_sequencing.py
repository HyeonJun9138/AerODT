"""Who lands next, and what the wait cost.

The rule is first come, first served on one pad at a time. These tests fix that
two aircraft are never given the same pad at the same moment, that the wait is
measured against when the aircraft would have arrived rather than against when
it asked, and that a landing number is issued once and never reused.
"""
from digital_twin.simulation import psu_sequencing as psu
from types import SimpleNamespace


def sequencer(stands=("G1", "G2")):
    return psu.PsuSequencer(stands=lambda vertiport: list(stands))


def arrive(service, flight, at, *, vertiport="VP001", fato="F2", stand="G1", now=None):
    return service.request_arrival(flight_id=flight, vertiport=vertiport, fato=fato, stand=stand,
                                   earliest_s=at, now_s=now if now is not None else at - 180)


def test_one_pad_takes_one_landing_at_a_time_and_the_second_waits():
    service = sequencer()
    first = arrive(service, "A", 1000)
    second = arrive(service, "B", 1030, stand="G2")
    assert first.state == psu.GRANTED and first.hold_s == 0
    assert second.state == psu.HOLDING
    # The second may not touch down until the first has cleared the pad.
    assert second.cleared_s == first.cleared_s + psu.FATO_LANDING_SEPARATION_S
    assert second.hold_s == second.cleared_s - 1030
    # The wait is against when it would have arrived, not when it asked.
    assert second.hold_s == round(first.cleared_s + psu.FATO_LANDING_SEPARATION_S - 1030, 6)
    assert first.sequence == 1 and second.sequence == 2, "landing numbers, in the order asked"


def test_a_gap_wide_enough_is_not_a_wait():
    service = sequencer()
    arrive(service, "A", 1000)
    late = arrive(service, "B", 1000 + psu.FATO_LANDING_SEPARATION_S * 3, stand="G2")
    assert late.state == psu.GRANTED and late.hold_s == 0


def test_asking_first_holds_the_slot_but_does_not_close_the_pad():
    """First come, first served decides a contested slot, not every landing. An
    aircraft that fits in the gap ahead of the booking without touching it is
    not made to wait for it — delaying somebody to protect a slot that was never
    in question is a cost with nothing on the other side.

    What the rule does guarantee is that the aircraft which asked first is not
    moved: whoever comes after fits around it."""
    service = sequencer()
    booked = service.request_arrival(flight_id="A", vertiport="VP001", fato="F2", stand="G1",
                                     earliest_s=1200, now_s=900)
    fits = service.request_arrival(flight_id="B", vertiport="VP001", fato="F2", stand="G2",
                                   earliest_s=1000, now_s=950)
    assert booked.sequence == 1 and fits.sequence == 2
    assert booked.cleared_s == 1200, "the one that asked first is not moved"
    assert fits.cleared_s == 1000 and fits.state == psu.GRANTED
    assert fits.cleared_s + psu.FATO_LANDING_SEPARATION_S <= booked.cleared_s, "and the pad is clear in time"
    # One that does not fit in the gap goes behind the booking instead.
    crowds = service.request_arrival(flight_id="C", vertiport="VP001", fato="F2", stand="G1",
                                     earliest_s=1150, now_s=1000)
    assert crowds.state == psu.HOLDING
    assert crowds.cleared_s >= booked.cleared_s + psu.FATO_LANDING_SEPARATION_S


def test_a_departure_needs_the_same_pad_and_takes_its_turn():
    service = sequencer()
    landing = arrive(service, "A", 1000)
    leaving = service.request_departure(flight_id="B", vertiport="VP001", fato="F2",
                                        earliest_s=1010, now_s=1000)
    assert leaving.cleared_s >= landing.cleared_s + psu.FATO_MIXED_SEPARATION_S
    # A different pad at the same vertiport is not the same queue.
    other = service.request_departure(flight_id="C", vertiport="VP001", fato="F1",
                                      earliest_s=1010, now_s=1000)
    assert other.cleared_s == 1010 and other.state == psu.GRANTED


def test_landing_on_a_deck_with_nowhere_to_park_is_a_wait_too():
    """Clearing an aircraft onto a pad it cannot leave only moves the queue onto
    the taxiway. When the planned stand is taken it is given another, and when
    every stand is taken it waits."""
    service = sequencer(stands=("G1",))
    service.take_stand("VP001", "G1", "resident")
    blocked = arrive(service, "A", 1000)
    assert blocked.state == psu.HOLDING and "주기장" in blocked.reason
    # With a free stand it is moved rather than refused, and the move is said.
    roomy = psu.PsuSequencer(stands=lambda vertiport: ["G1", "G2"])
    roomy.take_stand("VP002", "G1", "resident")
    moved = roomy.request_arrival(flight_id="B", vertiport="VP002", fato="F2", stand="G1",
                                  earliest_s=1000, now_s=900)
    assert moved.stand == "G2" and "주기장 변경" in moved.reason
    assert moved.state == psu.GRANTED, "a different stand is not a delay"


def test_a_flight_asks_once_and_the_answer_stands():
    service = sequencer()
    first = arrive(service, "A", 1000)
    again = arrive(service, "A", 1500)
    assert again is first, "asking twice does not take a second slot or a second number"


def test_a_hold_past_the_limit_is_reported_rather_than_flown():
    service = sequencer(stands=("G1", "G2", "G3", "G4"))
    for index in range(40):
        arrive(service, f"F{index}", 1000, stand=f"G{index % 4 + 1}")
    refused = [clearance for clearance in service._log if clearance.state == psu.REFUSED]
    assert refused, "somebody eventually cannot be fitted in"
    assert all(clearance.hold_s > psu.MAXIMUM_HOLD_S for clearance in refused)
    assert service.statistics()["refused"] == len(refused)


def test_what_the_day_is_judged_by_is_kept():
    service = sequencer()
    arrive(service, "A", 1000)
    arrive(service, "B", 1010, stand="G2")
    arrive(service, "C", 1020, stand="G1", vertiport="VP002")
    held = service.holds()
    assert [item["flight_id"] for item in held] == ["B"], "only the ones that actually waited"
    assert held[0]["sequence"] == 2 and held[0]["vertiport"] == "VP001"
    statistics = service.statistics()
    assert statistics["requests"] == 3 and statistics["held"] == 1 and statistics["held_arrivals"] == 1
    assert statistics["hold_seconds_max"] == round(held[0]["hold_s"], 1)
    # Numbers count up per vertiport, so two decks both start at one.
    assert service.clearance("C").sequence == 1


def test_a_landing_that_has_happened_gives_the_pad_back():
    service = sequencer()
    first = arrive(service, "A", 1000)
    service.complete("A", psu.ARRIVAL, first.cleared_s + 60)
    assert service.clearance("A").released_s == first.cleared_s + 60
    # With the pad free again the next arrival is not held behind a landing that
    # is over.
    after = arrive(service, "B", first.cleared_s + 70, stand="G2")
    assert after.state == psu.GRANTED


def test_resetting_forgets_the_sequence_so_the_day_can_be_run_again():
    service = sequencer()
    arrive(service, "A", 1000)
    arrive(service, "B", 1010, stand="G2")
    service.reset()
    assert service.statistics()["requests"] == 0 and service.holds() == []
    fresh = arrive(service, "A", 1000)
    assert fresh.sequence == 1 and fresh.state == psu.GRANTED

def test_later_departure_request_preserves_existing_slot():
    service=sequencer()
    first=service.request_departure(flight_id='existing',vertiport='V',fato='F1',earliest_s=100,now_s=90)
    reserved=first.cleared_s
    later=service.request_departure(flight_id='new',vertiport='V',fato='F1',earliest_s=100,now_s=95)
    assert first.cleared_s == reserved
    assert later.cleared_s >= reserved+service.tuning.departure_separation_s


def test_psu_turns_departure_observations_into_operational_blockers():
    service=sequencer()
    blockers=service.departure_blockers(
        flight_id='D',origin='V',fato='F1',now_s=100,
        terminal_conflicts=[{'flight_id':'X','reason':'terminal_overlap'}],
        pad_occupants=[(('V','F2'),'Y')],adjacent_fatos=['F1','F2'],
        arrival_conflicts=[{
            'flight_id':'A','airborne':True,'failed':False,'clearance_state':psu.HOLDING,
            'clearance_released_s':None,'stand':'G1','approach_s':100,
            'approach_started_s':90,'hold_seconds':100,'assignment':None,
            'queue_return_clear':True,'instruction_action':'hold','vertiport':'V',
            'fato':'F1','overlap':{'horizontal_m':20},
        }])
    assert {item['reason'] for item in blockers} == {
        'terminal_overlap','pad_occupied','waiting_arrival_priority'}
    answer=service.assess_departure(flight_id='D',blockers=blockers)
    assert answer.state==psu.HOLDING
    assert answer.reason=='대기 도착편 우선 · 지상 출발 순서 조정'


def test_psu_owns_the_final_departure_slot_answer_without_moving_the_aircraft():
    service=sequencer()
    service.request_departure(flight_id='A',vertiport='V',fato='F1',earliest_s=100,now_s=90)
    waiting=service.authorize_departure(
        flight_id='B',vertiport='V',fato='F1',earliest_s=100,now_s=90)
    assert waiting.state==psu.HOLDING and waiting.reason=='공용 패드 운항 간격'
    assert waiting.clearance.flight_id=='B'
    assert service.clearance('B',psu.DEPARTURE) is waiting.clearance
    # The PSU answer is permission only. It does not own or mutate a Runtime pose.
    granted=service.authorize_departure(
        flight_id='C',vertiport='V',fato='F2',earliest_s=100,now_s=90)
    assert granted.state==psu.GRANTED and granted.reason=='이륙 경로 예약'


def test_psu_compares_vertiport_ground_route_proposals_without_searching_the_graph():
    service = sequencer()
    def candidate(route_id, rank, distance, blocked_by):
        flight = {
            'flight_id': 'D', 'origin': 'V', 'destination': 'W',
            'departure_fato': 'F1', 'arrival_fato': 'F2',
            '_departure_ground_route': {
                'route_id': route_id, 'rank': rank, 'distance_m': distance,
                'clear_distance_m': 0 if blocked_by else distance,
                'blocked_by': blocked_by,
            },
        }
        route = SimpleNamespace(
            phases=[SimpleNamespace(stage='gate_out', duration_s=distance / 4)],
            remaining_to_touchdown=lambda *_: 300 + distance / 4)
        return flight, route
    shortest = candidate('shortest', 1, 20, ['PARKED'])
    alternative = candidate('alternative', 2, 40, [])
    selected, _, assessment = service.select_departure_plan(
        [shortest, alternative], 100, [], lambda *_: [])
    assert selected['_departure_ground_route']['route_id'] == 'alternative'
    assert assessment['ground_route_rank'] == 2
    assert assessment['ground_route_blocked_by'] == []
def test_arrival_can_be_sequenced_without_a_gate_until_touchdown():
    service=psu.PsuSequencer(stands=lambda port:('G1','G2'))
    service.take_stand('VP','G1','PARKED-1')
    service.take_stand('VP','G2','PARKED-2')
    clearance=service.request_arrival(flight_id='A',vertiport='VP',fato='F1',stand='G1',
        earliest_s=100,now_s=0,stands=('G1','G2'),defer_stand=True)
    assert clearance.stand is None and clearance.deferred_stand
    service.refresh_arrivals({'A':{'eta_s':100,'remaining_s':100,'approach_ready':True}},0,buffer_s=0)
    assert clearance.approach_s==0
    assert service.begin_approach('A',0)


def test_default_uncommitted_arrival_order_follows_live_eta_not_request_order():
    service=sequencer(('G1','G2'))
    arrive(service,'EARLY_REQUEST',600,stand='G1',now=0)
    arrive(service,'NEAREST',300,stand='G2',now=1)
    service.refresh_arrivals({
        'EARLY_REQUEST':{'eta_s':600,'remaining_s':600,'approach_ready':True,'manual':False},
        'NEAREST':{'eta_s':300,'remaining_s':300,'approach_ready':True,'manual':True}},2,buffer_s=0)
    assert service.tuning.manual_arrival_priority is False
    assert service.clearance('NEAREST',psu.ARRIVAL).cleared_s < service.clearance('EARLY_REQUEST',psu.ARRIVAL).cleared_s


def test_four_shared_fatos_keep_two_for_imminent_departures():
    service=sequencer()
    first=service.protect_departure_capacity(
        takeoff_fatos=('F1','F2','F3','F4'),currently_blocked_fatos=(),
        candidate_blocked_fatos=('F1','F2'),pending_departures=('D1',),reserve_ratio=.5)
    assert first.granted and first.required==2 and first.available_after==2
    blocked=service.protect_departure_capacity(
        takeoff_fatos=('F1','F2','F3','F4'),currently_blocked_fatos=('F1','F2'),
        candidate_blocked_fatos=('F3',),pending_departures=('D1',),reserve_ratio=.5)
    assert not blocked.granted
    assert blocked.available_before==2 and blocked.available_after==1
    assert blocked.reason=='이륙 FATO 보호 대기 · 1/2개만 유지'


def test_two_dedicated_departure_pads_do_not_prohibit_every_adjacent_landing():
    service=sequencer()
    for adjacent in [('F1',), ('F3',)]:
        answer=service.protect_departure_capacity(
            takeoff_fatos=('F1','F3'),dedicated_takeoff_fatos=('F1','F3'),
            candidate_blocked_fatos=adjacent,pending_departures=('D1',),reserve_ratio=.5)
        assert answer.granted and answer.required==0
    blocked=service.protect_departure_capacity(
        takeoff_fatos=('F1','F3'),dedicated_takeoff_fatos=('F1','F3'),
        currently_blocked_fatos=('F1',),candidate_blocked_fatos=('F3',),
        pending_departures=('D1',),reserve_ratio=.5)
    assert blocked.granted and blocked.required==0  # Actual occupancy is checked separately.


def test_departure_capacity_rule_is_idle_without_a_departure_and_does_not_restore_old_loss():
    service=sequencer()
    idle=service.protect_departure_capacity(
        takeoff_fatos=('F1','F2','F3','F4'),candidate_blocked_fatos=('F1','F2','F3'),
        pending_departures=(),reserve_ratio=.5)
    assert idle.granted
    degraded=service.protect_departure_capacity(
        takeoff_fatos=('F1','F2','F3','F4'),unavailable_fatos=('F3','F4'),
        currently_blocked_fatos=('F1',),candidate_blocked_fatos=(),
        pending_departures=('D1',),reserve_ratio=.5)
    assert degraded.granted and degraded.required==1 and degraded.available_after==1
