"""Read-only views of the operating source shown in the Twin."""
import asyncio
from fastapi import APIRouter
from fastapi.responses import JSONResponse


def create_operating_context_router(context):
    router=APIRouter(prefix='/api/operations/context');headers={'Cache-Control':'no-store'}
    async def answer(call,*args):
        value=await asyncio.to_thread(call,*args)
        return JSONResponse(value,headers=headers)
    @router.get('/status')
    async def status():return await answer(context.status)
    @router.get('/environment')
    async def environment():return await answer(context.environment)
    @router.get('/revision')
    async def revision():return await answer(context.environment_stamp)
    @router.get('/decisions')
    async def decisions():return await answer(context.rule_description)
    @router.get('/profile')
    async def profile():return await answer(context.profile_description)
    @router.get('/vertiports')
    async def vertiports():return await answer(context.read,'vertiports')
    @router.get('/vertiports/{identifier}')
    async def deck(identifier:str):return await answer(context.read,'decks',identifier)
    @router.get('/pilots')
    async def pilots():return await answer(context.read,'pilots')
    @router.get('/aircraft/{identifier}')
    async def aircraft(identifier:str):return await answer(context.read,'aircraft',identifier)
    @router.get('/passengers')
    async def passengers():return await answer(context.read,'passengers')
    return router
