"""Versioned wire adapters for simulation assets. Logic is injected by composition."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def create_revision_router(revision):
    """`revision` answers a short document saying where the stored simulation
    data stands. Several people can have the map open at once and the server is
    one machine with one set of files, so a screen only needs to hear that the
    files moved — not what moved — and can then reload what it shows."""
    router = APIRouter()

    @router.get("/api/simulation/revision")
    async def read_revision():
        return {"schema_version": 1, **revision()}

    return router


def create_simulation_router(vertiports, edit_state=None):
    """`vertiports` exposes list(), get(id), create(body), update(id, body), delete(id), preview(body), options().

    Callables raise ValueError('field: reason') for invalid input; they return
    None for unknown identifiers. Everything returned is already wire-shaped.
    """
    router = APIRouter()

    async def body_of(request):
        try:
            return await request.json()
        except ValueError:
            raise ValueError("body: JSON object expected") from None

    def invalid(error):
        message = str(error)
        field, _, reason = message.partition(": ")
        return JSONResponse({"schema_version": 1, "error": "invalid_definition",
                             "field": field if reason else None, "message": message}, status_code=422)

    def locked_response():
        state = edit_state() if edit_state else {"locked": False}
        if state.get("locked"):
            return JSONResponse({"schema_version": 1, "error": "simulation_running", **state}, status_code=409)
        return None

    @router.get("/api/simulation/vertiports/edit-state")
    async def read_edit_state():
        return {"schema_version": 1, **(edit_state() if edit_state else {"locked": False})}

    @router.get("/api/simulation/vertiports")
    async def list_vertiports():
        return {"schema_version": 1, "vertiports": vertiports.list()}

    # Declared before the "/{identifier}" routes so the literal path wins.
    @router.get("/api/simulation/vertiports/options")
    async def vertiport_options():
        return {"schema_version": 1, **vertiports.options()}

    @router.post("/api/simulation/vertiports/preview")
    async def preview_vertiport(request: Request):
        try:
            return {"schema_version": 1, "layout": vertiports.preview(await body_of(request))}
        except PermissionError as error:
            return JSONResponse({"schema_version": 1, "error": "simulation_running", "message": str(error)}, status_code=409)
        except ValueError as error:
            return invalid(error)

    @router.post("/api/simulation/vertiports", status_code=201)
    async def create_vertiport(request: Request):
        try:
            body = await body_of(request)
            blocked = locked_response()
            if blocked is not None: return blocked
            return {"schema_version": 1, "vertiport": vertiports.create(body)}
        except PermissionError as error:
            return JSONResponse({"schema_version": 1, "error": "simulation_running", "message": str(error)}, status_code=409)
        except ValueError as error:
            return invalid(error)

    @router.get("/api/simulation/vertiports/{identifier}")
    async def get_vertiport(identifier: str):
        record = vertiports.get(identifier)
        if record is None:
            return JSONResponse({"schema_version": 1, "error": "unknown_vertiport"}, status_code=404)
        return {"schema_version": 1, "vertiport": record}

    @router.put("/api/simulation/vertiports/{identifier}")
    async def update_vertiport(identifier: str, request: Request):
        try:
            body = await body_of(request)
            blocked = locked_response()
            if blocked is not None: return blocked
            record = vertiports.update(identifier, body)
        except PermissionError as error:
            return JSONResponse({"schema_version": 1, "error": "simulation_running", "message": str(error)}, status_code=409)
        except ValueError as error:
            return invalid(error)
        if record is None:
            return JSONResponse({"schema_version": 1, "error": "unknown_vertiport"}, status_code=404)
        return {"schema_version": 1, "vertiport": record}

    @router.delete("/api/simulation/vertiports/{identifier}", status_code=204)
    async def delete_vertiport(identifier: str):
        blocked = locked_response()
        if blocked is not None: return blocked
        try:
            deleted = vertiports.delete(identifier)
        except PermissionError as error:
            return JSONResponse({"schema_version": 1, "error": "simulation_running", "message": str(error)}, status_code=409)
        if not deleted:
            return JSONResponse({"schema_version": 1, "error": "unknown_vertiport"}, status_code=404)
        return JSONResponse(None, status_code=204)

    return router


def create_route_router(routes, place_lookup=None, conflicts=None):
    """`routes` exposes network(), options(), create_node(body), update_node(id, body),
    delete_node(id), create_link(body), update_link(id, body), delete_link(id).
    `place_lookup(latitude, longitude)` is an awaitable answering a locality
    name or None; without one the place endpoint answers no name.
    `conflicts(body)` is an awaitable answering the building-conflict report for
    the links in `body`, raising ValueError('field: reason') for a bad body;
    without one the check answers 404, meaning no building data is configured.

    Same conventions as the vertiport router: ValueError('field: reason') is
    422 with the field named, an unknown identifier is 404.
    """
    router = APIRouter()

    async def body_of(request):
        try:
            return await request.json()
        except ValueError:
            raise ValueError("body: JSON object expected") from None

    def invalid(error):
        message = str(error)
        field, _, reason = message.partition(": ")
        return JSONResponse({"schema_version": 1, "error": "invalid_definition",
                             "field": field if reason else None, "message": message}, status_code=422)

    def unknown(what):
        return JSONResponse({"schema_version": 1, "error": f"unknown_{what}"}, status_code=404)

    @router.get("/api/simulation/routes")
    async def route_network():
        return {"schema_version": 1, **routes.network()}

    @router.get("/api/simulation/routes/options")
    async def route_options():
        return {"schema_version": 1, **routes.options()}

    @router.get("/api/simulation/routes/place")
    async def route_place(latitude: float, longitude: float):
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            return invalid(ValueError("latitude: outside the globe"))
        name = await place_lookup(latitude, longitude) if place_lookup else None
        return {"schema_version": 1, "name": name}

    @router.post("/api/simulation/routes/conflicts")
    async def route_conflicts(request: Request):
        if conflicts is None:
            return JSONResponse({"schema_version": 1, "error": "buildings_not_configured"}, status_code=404)
        try:
            return {"schema_version": 1, **(await conflicts(await body_of(request)))}
        except ValueError as error:
            return invalid(error)
        except Exception:
            # Never relay the building provider's bodies or URLs.
            return JSONResponse({"schema_version": 1, "error": "building_provider_unavailable"}, status_code=503)

    @router.post("/api/simulation/routes/nodes", status_code=201)
    async def create_node(request: Request):
        try:
            return {"schema_version": 1, "node": routes.create_node(await body_of(request))}
        except ValueError as error:
            return invalid(error)

    @router.put("/api/simulation/routes/nodes/{identifier}")
    async def update_node(identifier: str, request: Request):
        try:
            record = routes.update_node(identifier, await body_of(request))
        except ValueError as error:
            return invalid(error)
        return unknown("node") if record is None else {"schema_version": 1, "node": record}

    @router.delete("/api/simulation/routes/nodes/{identifier}")
    async def delete_node(identifier: str):
        removed = routes.delete_node(identifier)
        return unknown("node") if removed is None else {"schema_version": 1, "removed_links": removed}

    @router.post("/api/simulation/routes/links", status_code=201)
    async def create_link(request: Request):
        try:
            return {"schema_version": 1, "link": routes.create_link(await body_of(request))}
        except ValueError as error:
            return invalid(error)

    @router.put("/api/simulation/routes/links/{identifier}")
    async def update_link(identifier: str, request: Request):
        try:
            record = routes.update_link(identifier, await body_of(request))
        except ValueError as error:
            return invalid(error)
        return unknown("link") if record is None else {"schema_version": 1, "link": record}

    @router.delete("/api/simulation/routes/links/{identifier}", status_code=204)
    async def delete_link(identifier: str):
        if not routes.delete_link(identifier):
            return unknown("link")
        return JSONResponse(None, status_code=204)

    return router
