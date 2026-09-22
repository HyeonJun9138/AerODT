"""Wire for the demand setup: the reference weights each deck starts from.

Small and read-only. The panel asks once when it opens, and everything after
that — what the operator changes, and what the generator is eventually asked
for — travels in the request the panel builds.
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from digital_twin.model_library import demand_profile, demand_ratios, schedule_planning


def create_demand_router(vertiports):
    """`vertiports` answers the placed vertiports, so the defaults name real decks."""
    router = APIRouter()

    @router.get("/api/simulation/demand/defaults")
    async def defaults():
        try:
            records = list(vertiports())
        except Exception:
            records = []
        return JSONResponse({**demand_ratios.describe(), "profile": demand_profile.describe(),
                             "schedule_planning": schedule_planning.defaults(),
                             "vertiports": demand_ratios.defaults_for(records)},
                            headers={"Cache-Control": "no-store"})

    return router
