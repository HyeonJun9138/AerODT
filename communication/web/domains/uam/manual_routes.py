"""Manual simulation wire v1. No hardware commands; each socket owns one runtime."""
import asyncio
import math
import time
from pathlib import Path
from fastapi import APIRouter,WebSocket,WebSocketDisconnect
from starlette.concurrency import run_in_threadpool
from communication.python.manual_runtime import ManualRuntime
from user_application.uam_mission.manual_flight import ManualFlight
from user_application.uam_mission.manual_surfaces import departure_surface
from user_application.uam_mission import twin_custody

# How long one read waits before the pilot is treated as quiet, and how long a
# quiet pilot keeps the aircraft. A page that goes quiet has not left: the tab
# is hidden, the machine is busy, the network stalled. Ending the flight for it
# meant the pilot came back to nothing and had to start again, which is how a
# quarter of the recorded manual flights ended. Now the aircraft is simply held
# where it is until nobody could still be coming back. Module level so a test
# does not have to sit through the real wait.
# Module level for the same reason the silence timers above are: a test must be
# able to read what one message is allowed to carry without standing up a router.
# One physics step, how much of it one message may apply, and how much of a
# delivery gap is carried forward instead of discarded.
STEP_SECONDS=.004
# How much flight time one message may carry. This is the ceiling that
# decides whether the pilot's clock keeps real time, because the browser
# sends from the main thread: the send timer and the reply handler both
# queue behind the frame, so messages per second follows the page's frame
# rate. At 60 ms a page drawing 12 frames a second can only advance 0.72
# seconds of flight per real second, and the shortfall accumulates in
# `remainder` rather than being caught up. Modelled against this loop:
#
#   browser fps      60 ms       100 ms
#        17          1.00x        1.00x
#        12          0.72x        1.00x
#        10          0.60x        1.00x
#         8          0.48x        0.80x
#
# 100 ms holds real time down to ten frames a second. It is a ceiling, so a
# page keeping up never reaches it and nothing changes for one: at 20 Hz a
# message carries 50 ms and always did. The evenness the old 60 ms bought is
# only given up on a page already drawing in 80-100 ms steps, where a 100 ms
# advance is no lumpier than the frame that shows it.
STEPS_PER_MESSAGE=25
CARRY_SECONDS=.25

SILENCE_SECONDS=30
ABANDON_SECONDS=180

def validate_command(body):
    if not isinstance(body,dict):raise ValueError('command object required')
    out={}
    for key,lo,hi in [('throttle',0,1),('roll',-1,1),('pitch',-1,1),('yaw',-1,1)]:
        value=body.get(key,0) if key=='yaw' else body.get(key)
        if isinstance(value,bool) or not isinstance(value,(float,int)) or not math.isfinite(value) or not lo<=value<=hi:raise ValueError(key)
        out[key]=value
    if body.get('flight_mode') not in ('fixed_wing','multirotor'):raise ValueError('flight_mode')
    out['flight_mode']=body['flight_mode'];return out

def _share(scenario,aircraft_id,sample,step):
    """Put this pose where the rest of the day can see it.

    Failing to reach the day must never stop the aircraft being flown: the
    pilot is holding the stick, and a scenario that was closed underneath them
    is not their problem.
    """
    day=scenario() if callable(scenario) else scenario
    at=(sample or {}).get('position') or {}
    if not day or at.get('latitude') is None:return False
    try:
        return day.place_manual(aircraft_id,latitude=at['latitude'],longitude=at['longitude'],
            altitude=at.get('altitude_m'),heading=sample.get('heading_deg'),step=step,
            airborne=bool(sample.get('airborne')),speed_mps=sample.get('speed_mps'),
            telemetry={key:sample[key] for key in ('pitch_deg','roll_deg','tilt_deg','rotor_radps','control_surface_deg','velocity_ned_mps') if key in sample})
    except Exception:
        return False


def _watch(scenario, aircraft_id):
    """Register this aircraft with the day, once, when the socket opens.

    This is the one call on the socket's day path that still takes the
    session's lock, and it is what pays for every later read being free of it:
    it registers the aircraft so the day's own tick keeps an advisory ready,
    and computes the first one, so `_sync_ground` has an answer from its very
    first read rather than nothing until a tick has gone by.

    A day that cannot be reached leaves this flight without an advisory, which
    is the same degraded flight a day that throws has always produced, and is
    not a reason to refuse a pilot who is ready to fly.
    """
    day=scenario() if callable(scenario) else scenario
    if not day:return False
    try:
        day.manual_watch(aircraft_id);return True
    except Exception:
        return False


def _hand_back(scenario, aircraft_id):
    """Drop the watch and give the airframe back, in that order, in one hop.

    Unwatching first because it also discards a pose the pilot posted that the
    day's tick has not drained yet, and a day that is flying this aircraft
    again must not then be handed that pose.

    One hop rather than two awaits, and not for speed. A socket the client
    closed is cancelled where it stands, and `CancelledError` is not an
    `Exception`, so no `except Exception` on the way out holds it. Traced under
    Starlette's TestClient, the cancellation lands on the *second* await after
    the disconnect and whatever sat there simply never ran -- with two awaits
    here that was `release_manual`, so the airframe stayed held by a pilot who
    had gone. One hand-off cannot be split that way. (The second await in this
    block is still `session.close`, and still loses its turn on that path; that
    is how it has always been and is not this function's to fix.)
    """
    day=scenario() if callable(scenario) else scenario
    if not day:return False
    try:day.manual_unwatch(aircraft_id)
    except Exception:pass
    try:day.release_manual(aircraft_id)
    except Exception:pass
    return True


def _sync_ground(scenario, aircraft_id, session):
    """Give the ground procedures the advisory the day's tick already worked out.

    A read of a cache, not a fresh computation. `manual_advisory` computes
    under the session's lock and `advance_view` holds that lock for ~110 ms of
    every tick -- measured at 62% of wall-clock time -- so asking for a fresh
    answer meant queueing behind a playing day on a path a pilot is waiting
    on. `manual_advice` returns what the tick last computed and takes no lock
    at all. The fresh, locked call still exists for the HTTP endpoint, which is
    nobody's message path.

    Reaching the day must still never stop the flight, and a day with no answer
    yet -- before the first tick after `_watch`, or once the registration is
    dropped -- gives the same `None` this has always handed `sync_psu` when it
    could not reach the day at all.
    """
    day=scenario() if callable(scenario) else scenario
    try:
        advice=day.manual_advice(aircraft_id) if day else None
    except Exception:
        advice=None
    session.ground.sync_psu(advice)


def _scenario_plan(planning,assignment):
    """A real plan for the flight the day gave this pilot.

    Built rather than synthesised: the runtime, the ground procedures and the
    display all already understand a plan, and the day knows every field one
    needs -- the pair, the assigned stands, who is aboard and which airframe.
    """
    flight=assignment.get('flight') or {}
    if not flight.get('origin') or not flight.get('destination'):
        raise ValueError('배정된 비행편에 출발지·도착지가 없습니다.')
    return planning.build({'from_vertiport':flight['origin'],'to_vertiport':flight['destination'],
        'visual_asset_id':assignment.get('asset_id'),
        'seat_capacity':assignment.get('seats',4),
        'from_gate':assignment.get('stand'),'to_gate':flight.get('arrival_stand'),
        'passengers':int(flight.get('passengers') or 0),'control_mode':'manual'})


def create_manual_router(planning,workspace,prediction_history=None,scenario=None,custody=None):
    router=APIRouter();active=set()
    elevation=None
    terrain=Path(workspace)/'terrain/user_dem'
    if (terrain/'manifest.json').is_file():
        from data.terrain.local_dem import LocalDem
        elevation=LocalDem(terrain).sample
    @router.websocket('/api/simulation/manual')
    async def manual(ws:WebSocket):
        origin_header=ws.headers.get('origin')
        if origin_header and origin_header.split('://')[-1]!=ws.headers.get('host'):await ws.close(code=1008);return
        if len(active)>=4:await ws.close(code=1013);return
        active.add(id(ws));session=None;status='stopped';flown=None;held=False
        try:
            await ws.accept();hello=await asyncio.wait_for(ws.receive_json(),10)
            # Two ways in. A saved plan is a flight of its own; an aircraft id is
            # one airframe of a running day, handed over by the scenario -- and
            # from then on every sample goes back into that day, because the
            # rest of the fleet has to see where this aircraft actually is.
            twin=hello.get('aircraft_id')
            if twin:
                day=scenario() if callable(scenario) else scenario
                # One hop, not two. Getting into the cockpit was seven of these
                # hand-offs, and each one waits for the GIL the day's tick holds.
                # Measured against the user's 6339-flight day: entry took 0.14 s
                # with the day stopped, 0.41 s at 27 airborne and 1.08 s at 63 --
                # almost all of it hop latency rather than work, because the work
                # itself is what the stopped day already showed. The plan is built
                # out of the assignment, so the two belong in one hand-off anyway.
                def prepare():
                    assignment=day.manual_assignment(twin) if day else None
                    return (assignment,_scenario_plan(planning,assignment)) if assignment else (None,None)
                assignment,plan=await run_in_threadpool(prepare)
                if not assignment:raise ValueError('배정받은 기체가 아닙니다. 다중 비행에서 먼저 배정받으세요.')
                flown=twin
            else:
                # A flight of its own drives the twin, so it cannot start while
                # a whole day is driving it. The day's own aircraft, flown by
                # hand, is the day rather than a second thing beside it.
                if custody is not None:
                    try:custody.take(twin_custody.SINGLE)
                    except twin_custody.TwinBusy as busy:raise ValueError(str(busy)) from None
                    held=True
                prepared=planning.get(hello.get('plan_id'))
                if not prepared:raise ValueError('저장된 계획을 찾을 수 없습니다.')
                plan=prepared['plan'];flown=None
                if plan.get('control_mode')!='manual':raise ValueError('Manual 모드로 계획을 다시 저장하세요.')
            point=plan['legs'][0]['path'][0]
            altitude=hello.get('altitude_m')
            if isinstance(altitude,bool) or not isinstance(altitude,(int,float)) or not math.isfinite(altitude) or not -500<=altitude<=10000:raise ValueError('지형 고도 오류')
            path=plan['legs'][0]['path'];next_point=path[1] if len(path)>1 else [point[0],point[1]+.001]
            yaw=math.degrees(math.atan2((next_point[0]-point[0])*math.cos(math.radians(point[1])),next_point[1]-point[1]))
            origin,decks=departure_surface(plan,altitude,hello.get('contact_decks',[]))
            # The runtime and the flight that owns it, in one hand-off. This also
            # takes `ManualFlight` off the event loop, where it read the ground
            # layouts and prepared the decks while every other socket and request
            # in the process waited: one pilot arriving was a stall for everyone.
            def build():
                runtime=ManualRuntime(yaw)
                try:return ManualFlight(plan,origin,runtime,Path(workspace),decks,elevation if decks else None,planning.ground_layouts() if hasattr(planning,'ground_layouts') else ())
                except Exception:runtime.close();raise
            session=await run_in_threadpool(build)
            # Four hops became one, and the order inside is the order these must
            # happen in. Register before the first read: the cache `_sync_ground`
            # reads is empty until the day has been asked to keep one, so a sync
            # that ran first would start the flight with no advisory and not get
            # one until a tick later. Then the first sample, then post it where
            # the rest of the day can see it.
            def arm():
                if flown:
                    _watch(scenario,flown)
                    _sync_ground(scenario,flown,session)
                produced=session.initialize_grounded()
                if flown:_share(scenario,flown,produced,None)
                return produced
            sample=await run_in_threadpool(arm)
            if prediction_history is not None:
                prediction_history.open(session.logger.run_id,plan)
                prediction_history.append(session.logger.run_id,sample)
            await ws.send_json({'type':'ready','capabilities':['ground_handling_v1','ground_handling_v2',*(['next_flight_v1'] if flown else []),*(['autopilot_v1'] if getattr(session.runtime,'guidance_writer',None) else [])],'run_id':session.logger.run_id,'sample':sample,
                **({'plan':plan,'aircraft_id':flown} if flown else {}),'limitations':'버티포트 상면 접촉; 건물 벽 충돌 미지원; AirTaxi 공통 동역학; 배터리 추정'})
            last=time.monotonic();sequence=-1;paused=False;remainder=0.0;ground_sync_at=last;quiet_since=None
            while True:
                try:
                    body=await asyncio.wait_for(ws.receive_json(),SILENCE_SECONDS)
                except asyncio.TimeoutError:
                    now=time.monotonic()
                    if quiet_since is None:quiet_since=last
                    if now-quiet_since>=ABANDON_SECONDS:status='input_timeout';break
                    # Hold the aircraft rather than end the flight, and say so
                    # once. Physics does not advance and no held control is
                    # replayed, so the pose the pilot left is the pose they
                    # return to; coming back is a resume, not a new flight.
                    if not paused:
                        paused=True;remainder=0
                        try:await ws.send_json({'type':'paused','reason':'입력이 끊겨 대기 중 · 창으로 돌아오면 재개됩니다'})
                        except Exception:status='input_timeout';break
                    last=now
                    continue
                quiet_since=None
                if body.get('type')=='stop':break
                now=time.monotonic();elapsed=now-last;last=now
                if body.get('type')=='keepalive':
                    # This socket exclusively advances the native runtime. Between
                    # commands its pose is still authoritative, including while
                    # input is paused. Keep PSU observation freshness independent
                    # of pilot input without stepping physics or replaying controls.
                    if flown:
                        await run_in_threadpool(_share,scenario,flown,sample,None)
                        await run_in_threadpool(_sync_ground,scenario,flown,session)
                    await ws.send_json({'type':'alive'});continue
                if body.get('type')=='resume':
                    paused=False;remainder=0;await ws.send_json({'type':'resumed'});continue
                if body.get('type')=='pause':
                    paused=True;remainder=0;await ws.send_json({'type':'paused'});continue
                if body.get('type')=='autopilot':
                    request_id=body.get('request_id')
                    if body.get('enabled') is not False and (paused or elapsed>2):
                        reply={'accepted':False,'message':'수동 입력 재개 후 AP를 켜세요','sample':sample}
                    else:
                        reply=await run_in_threadpool(session.autopilot_request,body.get('enabled'))
                        sample=reply['sample']
                    await ws.send_json({'type':'autopilot_ack','request_id':request_id,**reply});continue
                if body.get('type')=='hold':
                    # Its own message rather than a flavour of `autopilot`: a
                    # hold is not the route autopilot, it is answered whatever
                    # the aircraft is doing, and it is on a stick button, so it
                    # must not queue behind anything.
                    request_id=body.get('request_id')
                    reply=await run_in_threadpool(session.hold_request,body.get('mode'))
                    if reply.get('sample'):sample=reply['sample']
                    await ws.send_json({'type':'hold_ack','request_id':request_id,**reply});continue
                if body.get('type')=='ground':
                    request_id=body.get('request_id')
                    if paused or elapsed>2:
                        await ws.send_json({'type':'ground_ack','request_id':request_id,'accepted':False,'message':'수동 입력을 재개한 뒤 요청하세요'})
                    else:
                        # The advisory this picks up is the one the day's tick
                        # last worked out, so it can be about a second old. That
                        # matters here and nowhere else on this socket: a 하차
                        # request is refused until PSU has the GATE report, so a
                        # pilot who asks in the second right after reporting can
                        # be told to wait and has to ask again. Asking the day
                        # for a fresh answer instead would put this socket back
                        # behind the session lock, which is what made a pilot's
                        # clock run at 0.4x.
                        if flown:await run_in_threadpool(_sync_ground,scenario,flown,session)
                        if body.get('action')=='next_flight':
                            if not flown:
                                reply={'accepted':False,'message':'운항 일정에서 배정받은 기체만 다음 비행을 이어갈 수 있습니다','sample':sample}
                            else:
                                def continue_next():
                                    state=session.ground.snapshot(session.observation,session.command)
                                    if state.get('phase')!='released':
                                        raise ValueError('충전 해제와 문 닫기를 마친 뒤 다음 비행을 준비하세요')
                                    day=scenario() if callable(scenario) else scenario
                                    assignment=day.continue_manual(flown,battery_pct=session.battery) if day else None
                                    if not assignment:raise ValueError('다음 비행 배정을 받지 못했습니다')
                                    next_plan=_scenario_plan(planning,assignment)
                                    advice=day.manual_advisory(flown)
                                    produced=session.continue_plan(next_plan,advice)
                                    return assignment,next_plan,produced
                                try:
                                    next_assignment,plan,sample=await run_in_threadpool(continue_next)
                                    reply={'accepted':True,'message':f"{next_assignment['flight']['flight_id']} 다음 비행 준비 · 출발 허가는 PSU에 별도로 요청하세요",
                                           'sample':sample,'plan':plan,'assignment':next_assignment}
                                except ValueError as error:
                                    reply={'accepted':False,'message':str(error),'sample':sample}
                        else:
                            reply=await run_in_threadpool(session.ground_request,body.get('action'),request_id)
                        sample=reply['sample']
                        if flown:await run_in_threadpool(_share,scenario,flown,sample,None)
                        await ws.send_json({'type':'ground_ack','request_id':request_id,**reply})
                    continue
                seq=body.get('sequence')
                if type(seq) is not int or seq<=sequence:raise ValueError('sequence')
                sequence=seq;command=validate_command(body)
                # Never replay a stale held key after a stall. Client resumes explicitly.
                if paused or elapsed>2.0:
                    paused=True;remainder=0;await ws.send_json({'type':'paused','reason':'입력 지연으로 일시정지'});continue
                # Physics advances by the gap between the client's messages, so the
                # size of each advance is set by network timing. Applying a whole
                # gap at once made a turn arrive in lumps: measured, the advance
                # swung between 36 and 100 ms once the round trip passed 40 ms,
                # which is seen as the heading stalling and then jumping. A
                # smaller ceiling per message keeps each advance even, and the
                # overflow stays in `remainder` rather than being thrown away, so
                # the simulation still keeps real time.
                remainder+=min(CARRY_SECONDS,elapsed)
                steps=min(STEPS_PER_MESSAGE,max(0,int(remainder/STEP_SECONDS)));remainder-=steps*STEP_SECONDS
                # A message that advances nothing needs no physics and no logged
                # sample; it still answers, so the client can send the next one.
                if steps:
                    # One hop, not four. Every hand-off between this loop and a
                    # worker waits for the GIL that the day's tick is holding,
                    # and the round trip is what sets how many messages a second
                    # the pilot gets -- which is what the simulated clock is
                    # made of. One round trip was measured at 37.8 ms at the
                    # median while a day was playing, against under 2 ms of work
                    # at the other end. Most of that 37.8 ms was not the hand-off
                    # but the session's lock, which `_share` and `_sync_ground`
                    # both waited on then and neither takes now; the number has
                    # not been measured again since the lock came off, so read
                    # it as what four hops cost under a lock, not as what one
                    # hop costs today. The GIL wait is still real, so the hop
                    # count still matters and this stays one hop.
                    # The order below is the order these must happen in: ground
                    # state before the step, `_share` reads the sample the step
                    # just produced, and the history de-duplicates on its time.
                    sync_ground=bool(flown and now-ground_sync_at>=1)
                    def advance():
                        if sync_ground:_sync_ground(scenario,flown,session)
                        produced=session.step(command,steps)
                        if flown:_share(scenario,flown,produced,steps*STEP_SECONDS)
                        if prediction_history is not None:
                            prediction_history.append(session.logger.run_id,produced)
                        return produced
                    sample=await run_in_threadpool(advance)
                    if sync_ground:ground_sync_at=now
                await ws.send_json({'type':'state','sequence':seq,'sample':sample})
        # A socket that went away without saying stop is not the same ending as
        # a pilot who pressed 종료, and the run log could not tell them apart.
        except WebSocketDisconnect:status='disconnected'
        except asyncio.TimeoutError:status='input_timeout'
        except Exception as error:
            status='failed'
            try:await ws.send_json({'type':'error','message':str(error)})
            except Exception:pass
        finally:
            active.discard(id(ws))
            if held and custody is not None:custody.release(twin_custody.SINGLE)
            # Handing the airframe back is the day's business, not the socket's,
            # and it has to happen however this ended.
            if flown:
                try:await run_in_threadpool(_hand_back,scenario,flown)
                except Exception:pass
            if session:
                if prediction_history is not None:prediction_history.close(session.logger.run_id)
                await run_in_threadpool(session.close,status)
            try:await ws.close()
            except Exception:pass
    return router
