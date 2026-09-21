from tempfile import TemporaryDirectory
from fastapi import FastAPI
from fastapi.testclient import TestClient
from communication.web.manual_routes import create_manual_router
from test_manual_day_bridge import Day, Planning


def test_paused_pilot_keeps_current_frozen_pose_visible_to_psu_without_advancing_physics():
    day=Day()
    with TemporaryDirectory() as directory:
        app=FastAPI()
        app.include_router(create_manual_router(Planning(),directory,scenario=lambda:day))
        with TestClient(app) as client:
            with client.websocket_connect('/api/simulation/manual') as ws:
                ws.send_json({'aircraft_id':'A1','altitude_m':30,'contact_decks':[]})
                ready=ws.receive_json();assert ready['type']=='ready'
                ws.send_json({'type':'pause'});assert ws.receive_json()['type']=='paused'
                count=len(day.poses)
                initial=day.poses[-1][1].copy()
                for _ in range(3):
                    ws.send_json({'type':'keepalive'})
                    assert ws.receive_json()['type']=='alive'
                assert len(day.poses)==count+3
                assert day.poses[-1][1]==initial
                ws.send_json({'type':'stop'})


def test_heartbeat_unblocks_pending_psu_request_after_input_pause(monkeypatch):
    from types import SimpleNamespace
    from digital_twin.simulation import manual_takeover as manual, manual_procedure
    from test_manual_takeover import day as make_day
    now=[100.]
    monkeypatch.setattr(manual_procedure,'time',SimpleNamespace(monotonic=lambda:now[0]))
    engine=make_day()
    aircraft_id=next(iter(engine.aircraft))
    assignment=manual.hand_over(engine,aircraft_id)
    aircraft=engine.aircraft[aircraft_id]
    class ConnectedDay(Day):
        def place_manual(self,identifier,**pose):
            return manual.place(engine,identifier,**pose)
        def release_manual(self,identifier):
            return manual.release(engine,identifier)
    connected=ConnectedDay(assignment)
    try:
        with TemporaryDirectory() as directory:
            app=FastAPI()
            app.include_router(create_manual_router(Planning(),directory,scenario=lambda:connected))
            with TestClient(app) as client:
                with client.websocket_connect('/api/simulation/manual') as ws:
                    ws.send_json({'aircraft_id':aircraft_id,'altitude_m':30,'contact_decks':[]})
                    assert ws.receive_json()['type']=='ready'
                    ws.send_json({'type':'pause'});assert ws.receive_json()['type']=='paused'
                    engine._departure_blockers=lambda *args:[{'flight_id':'BLOCKER'}]
                    assert manual.request(engine,aircraft_id,'departure')['state']=='hold'
                    now[0]+=4
                    assert not manual_procedure.fresh(aircraft)
                    manual.advance_request(engine,aircraft,engine.time_s+1)
                    assert aircraft.external['departure_pending']
                    engine._departure_blockers=lambda *args:[]
                    before=(aircraft.latitude,aircraft.longitude,aircraft.altitude)
                    ws.send_json({'type':'keepalive'});assert ws.receive_json()['type']=='alive'
                    assert manual_procedure.fresh(aircraft)
                    manual.advance_request(engine,aircraft,engine.time_s+2)
                    assert aircraft.external['last_answer']['state']=='granted'
                    assert 'departure_pending' not in aircraft.external
                    assert before==(aircraft.latitude,aircraft.longitude,aircraft.altitude)
                    ws.send_json({'type':'stop'})
    finally:engine.close()
