"""Wire for the pilot's operating speeds: read them, set them, put them back.

Small and shared. One profile for the whole dashboard, because a flight built
at one set of speeds and drawn beside a flight built at another would be two
different days on the same map.
"""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from digital_twin.model_library import uam_operating_profile


def create_operating_profile_router(settings):
    """`settings` reads, writes and resets the stored profile."""
    router = APIRouter()

    def described():
        return JSONResponse(uam_operating_profile.describe(settings.read()),
                            headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/operating-profile")
    async def read():
        return described()

    @router.put("/api/simulation/operating-profile")
    async def write(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid", "message": "JSON 본문이 필요합니다"}, status_code=422)
        if not isinstance(body, dict):
            return JSONResponse({"error": "invalid", "message": "JSON 객체가 필요합니다"}, status_code=422)
        try:
            settings.write(body.get("values") if isinstance(body.get("values"), dict) else body)
        except ValueError as error:
            return JSONResponse({"error": "invalid", "message": str(error)}, status_code=422)
        except OSError:
            return JSONResponse({"error": "unavailable", "message": "설정을 저장하지 못했습니다"}, status_code=503)
        return described()

    @router.post("/api/simulation/operating-profile/reset")
    async def reset():
        try:
            settings.reset()
        except OSError:
            return JSONResponse({"error": "unavailable", "message": "설정을 저장하지 못했습니다"}, status_code=503)
        return described()

    return router
