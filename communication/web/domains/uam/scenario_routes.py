"""Wire for a scheduled day: load it, drive it, read what it is doing.

The file arrives as its own bytes rather than as a form, so no upload parser is
needed and nothing is written to disk on the way in. Everything else is small
JSON: the control panel polls the status, and asks about one flight, one
aircraft or one deck when the operator opens it.
"""
import asyncio
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

# A flight plan file. Comfortably above the 191 KB day this was built for and
# far below anything that would take a noticeable time to parse.
MAX_UPLOAD_BYTES = 32 * 1024 * 1024
ACTIONS = ("open_control", "close_control", "play", "pause", "stop", "reset")


def create_scenario_router(session, *, load_example=None):
    router = APIRouter()

    def invalid(error):
        return JSONResponse({"error": "invalid", "message": str(error)}, status_code=422)

    def missing():
        return JSONResponse({"error": "not_found", "message": "불러온 비행계획이 없습니다"}, status_code=404)

    @router.get("/api/simulation/scenario")
    async def description():
        return JSONResponse(await asyncio.to_thread(session.description), headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/status")
    async def status():
        # Read only: multiple clients must never multiply the physics tick rate.
        return JSONResponse(await asyncio.to_thread(session.status), headers={"Cache-Control": "no-store"})

    @router.post("/api/simulation/scenario/example", status_code=201)
    async def example():
        if load_example is None:
            return invalid("예시 비행계획이 설정되지 않았습니다")
        try:
            return JSONResponse(await asyncio.to_thread(load_example), status_code=201)
        except (ValueError, OSError) as error:
            return invalid(error)

    @router.post("/api/simulation/scenario", status_code=201)
    async def load(request: Request):
        body = await request.body()
        if not body:
            return invalid("빈 파일입니다")
        if len(body) > MAX_UPLOAD_BYTES:
            return invalid("파일이 너무 큽니다")
        name = (request.headers.get("x-aerodt-filename") or "").strip()[:120]
        try:
            return JSONResponse(await asyncio.to_thread(session.load, body, name=name), status_code=201)
        except ValueError as error:
            return invalid(error)

    @router.delete("/api/simulation/scenario", status_code=200)
    async def clear():
        return JSONResponse(await asyncio.to_thread(session.clear))

    @router.post("/api/simulation/scenario/control")
    async def control(request: Request):
        try:
            body = await request.json()
        except Exception:
            return invalid("JSON 본문이 필요합니다")
        if not isinstance(body, dict):
            return invalid("JSON 객체가 필요합니다")
        action = str(body.get("action") or "").strip()
        try:
            if "speed" in body:
                await asyncio.to_thread(session.set_speed, body["speed"])
            if action and action not in ACTIONS:
                return invalid(f"동작: {', '.join(ACTIONS)} 중에서 고르세요")
            if action:
                await asyncio.to_thread(getattr(session, action))
        except ValueError as error:
            return invalid(error)
        return JSONResponse(await asyncio.to_thread(session.status))

    # ---- one aircraft of the day, flown by a person -----------------------
    @router.get("/api/simulation/scenario/manual/offers")
    async def manual_offers(asset_id: str = "", vertiport: str = "", seats: int = 0):
        """What a person could be given right now: the airframes, and the flights."""
        models, flights = await asyncio.gather(
            asyncio.to_thread(session.manual_models, vertiport or None),
            asyncio.to_thread(session.manual_candidates, asset_id or None, vertiport or None, seats or None))
        return JSONResponse({"models": models, "flights": flights},
                            headers={"Cache-Control": "no-store"})

    @router.post("/api/simulation/scenario/manual/assign")
    async def manual_assign(request: Request):
        try:
            body = await request.json()
        except Exception:
            return invalid("JSON 본문이 필요합니다")
        if not isinstance(body, dict):
            return invalid("JSON 객체가 필요합니다")
        try:
            return JSONResponse(await asyncio.to_thread(
                session.assign_manual, body.get("aircraft_id") or None,
                flight_id=body.get("flight_id") or None,
                asset_id=body.get("asset_id") or None,
                vertiport=body.get("vertiport") or None,
                seats=body.get("seats") or None))
        except ValueError as error:
            return invalid(error)

    @router.post("/api/simulation/scenario/manual/release")
    async def manual_release(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        identifier = (body or {}).get("aircraft_id") or None
        return JSONResponse(await asyncio.to_thread(session.release_manual, identifier))

    @router.get("/api/simulation/scenario/manual/{aircraft_id}")
    async def manual_advisory(aircraft_id: str):
        """Everything the service is saying to this pilot, in one reading."""
        found = await asyncio.to_thread(session.manual_advisory, aircraft_id)
        return missing() if found is None else JSONResponse(found, headers={"Cache-Control": "no-store"})

    @router.post("/api/simulation/scenario/manual/{aircraft_id}/request")
    async def manual_request(aircraft_id: str, request: Request):
        """The pilot asking the service for something, as a pilot does."""
        try:
            body = await request.json()
        except Exception:
            return invalid("JSON 본문이 필요합니다")
        if not isinstance(body, dict):
            return invalid("JSON 객체가 필요합니다")
        kind = str(body.get("kind") or "").strip()
        try:
            answer = await asyncio.to_thread(session.manual_request, aircraft_id, kind,
                                             eta_s=body.get("eta_s"),
                                             message_id=body.get("message_id"),
                                             sequence=body.get("sequence"),
                                             reference_message_id=body.get("reference_message_id"),
                                             reason=body.get("reason"))
        except ValueError as error:
            return invalid(error)
        return JSONResponse(answer, headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/events")
    async def events(since: int = 0, limit: int = 200):
        return JSONResponse({"since": since, "events": await asyncio.to_thread(session.events, since, min(limit, 1000))},
                            headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/holds")
    async def holds():
        return JSONResponse({"holds": await asyncio.to_thread(session.holds)}, headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/flights/{flight_id}")
    async def flight(flight_id: str):
        found = await asyncio.to_thread(session.flight, flight_id)
        return missing() if found is None else JSONResponse(found, headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/aircraft/{aircraft_id}")
    async def aircraft(aircraft_id: str):
        found = await asyncio.to_thread(session.aircraft, aircraft_id)
        return missing() if found is None else JSONResponse(found, headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/aircraft/{aircraft_id}/track")
    async def track(aircraft_id: str):
        """The path this airframe has flown on the flight being watched."""
        found = await asyncio.to_thread(session.track, aircraft_id)
        return missing() if found is None else JSONResponse(found, headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/passengers")
    async def passengers():
        """Everybody walking to or from an aircraft on a deck right now."""
        found = await asyncio.to_thread(session.passengers)
        return missing() if found is None else JSONResponse(found, headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/pilots")
    async def pilots():
        return JSONResponse(await asyncio.to_thread(session.pilot_operations),
                            headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/vertiports")
    async def vertiports():
        found = await asyncio.to_thread(session.vertiport_summary)
        return missing() if found is None else JSONResponse(found, headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/vertiports/{vertiport_id}")
    async def vertiport(vertiport_id: str):
        found = await asyncio.to_thread(session.vertiport, vertiport_id)
        return missing() if found is None else JSONResponse(found, headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/scenario/recording")
    async def recording():
        found = await asyncio.to_thread(session.recording)
        return missing() if found is None else JSONResponse(found, headers={"Cache-Control": "no-store"})

    return router
