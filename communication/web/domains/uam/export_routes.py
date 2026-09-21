"""Downloadable copies of the design data, saved by whichever computer asks.

The dashboard is reached over the network, so a download has to land on the
operator's own machine rather than the server's disk. That is what
`Content-Disposition: attachment` does: the browser writes the body to its own
downloads folder under the name given here. Nothing is written on the server.
"""
import json

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

_NO_STORE = {"Cache-Control": "no-store"}


def create_export_router(exports):
    """`exports` exposes describe() and build(kind), where build answers
    (filename, media_type, document) or None when there is nothing to hand
    over, and raises ValueError('kind: reason') for an unknown kind."""
    router = APIRouter()

    @router.get("/api/library/exports")
    async def list_exports():
        return JSONResponse(exports.describe(), headers=_NO_STORE)

    @router.get("/api/library/exports/{kind}")
    async def download(kind: str):
        try:
            built = exports.build(kind)
        except ValueError as error:
            return JSONResponse({"schema_version": 1, "error": "unknown_export", "message": str(error)},
                                status_code=404, headers=_NO_STORE)
        except Exception:
            # Never relay a store's own words: the panel says the download failed.
            return JSONResponse({"schema_version": 1, "error": "export_failed"}, status_code=503, headers=_NO_STORE)
        if built is None:
            return JSONResponse({"schema_version": 1, "error": "export_empty",
                                 "message": f"{kind}: 내려받을 자료가 아직 없습니다."},
                                status_code=409, headers=_NO_STORE)
        filename, media_type, document = built
        # ASCII in the header and the same name again as UTF-8, so a browser
        # that reads only one of the two still gets a usable name.
        # A document that is already text — a CSV, a line-delimited log — is
        # sent as it is. Only a structure is encoded.
        body = (document.encode("utf-8") if isinstance(document, str)
                else document if isinstance(document, (bytes, bytearray))
                else json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8"))
        return Response(body, media_type=media_type, headers={
            **_NO_STORE,
            "Content-Disposition": f'attachment; filename="{filename}"; filename*=UTF-8\'\'{filename}',
        })

    return router
