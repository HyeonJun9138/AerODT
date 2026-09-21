"""Versioned wire adapter for the coarse weather read. Logic is injected."""
from fastapi import APIRouter


def create_weather_router(conditions):
    """`conditions()` returns wire-shaped conditions, empty when nothing is held."""
    router = APIRouter()

    @router.get("/api/live/weather")
    async def read_weather():
        return conditions()

    return router
