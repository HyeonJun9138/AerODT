"""Read-only daily operations analysis; expensive evaluation stays off ASGI."""
import asyncio
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse, Response


def create_analysis_router(reports):
    router = APIRouter()
    headers = {'Cache-Control': 'no-store'}

    async def answer(function, *args, **kwargs):
        try:
            result = await asyncio.to_thread(function, *args, **kwargs)
            if result is None:
                return JSONResponse({'error': 'not_found', 'message': '해당 운항 기록이 없습니다.'}, status_code=404, headers=headers)
            return JSONResponse(result, headers=headers)
        except (OSError, ValueError, KeyError, TypeError):
            return JSONResponse({'error': 'record_unavailable', 'message': '운항 기록이 없거나 형식이 올바르지 않습니다.'}, status_code=404, headers=headers)

    @router.get('/api/simulation/analysis')
    async def summary(recording: str = 'current'):
        return await answer(reports.summary, recording)

    @router.get('/api/simulation/analysis/records')
    async def records():
        return await answer(reports.records_list)

    @router.get('/api/simulation/analysis/sorties')
    async def sorties(recording: str = 'current', vertiport: str = '', aircraft: str = '',
                      status: str = '', query: str = Query('', max_length=100),
                      fato: str = Query('', max_length=100), decision_reason: str = Query('', max_length=200),
                      hour: int = Query(-1, ge=-1, le=1000), hold_hour: int = Query(-1, ge=-1, le=1000), delay_bin: int = Query(-1, ge=-1, le=4),
                      page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100)):
        return await answer(reports.sorties, recording, vertiport=vertiport, aircraft=aircraft,
                            status=status, query=query, fato=fato, decision_reason=decision_reason, hour=hour, hold_hour=hold_hour, delay_bin=delay_bin, page=page, page_size=page_size)

    @router.get('/api/simulation/analysis/sorties/{flight_id}')
    async def sortie(flight_id: str, recording: str = 'current'):
        return await answer(reports.sortie, flight_id, recording)

    @router.get('/api/simulation/analysis/export')
    async def export(recording: str = 'current'):
        try:
            data = await asyncio.to_thread(reports.export, recording)
        except (OSError, ValueError, KeyError, TypeError):
            data = None
        if data is None:
            return JSONResponse({'error': 'not_found'}, status_code=404, headers=headers)
        return Response(data, media_type='text/csv; charset=utf-8', headers={**headers,
            'Content-Disposition': 'attachment; filename="operations-analysis.csv"'})

    return router
