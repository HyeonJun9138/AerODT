"""Bounded independent HTTP pulls; a slow aircraft shard cannot block the rest."""
import asyncio
from .physical_uam import fetch_packets


class PhysicalPolls:
    def __init__(self,client,fetch=fetch_packets):
        self.client=client;self.fetch=fetch;self.key=None;self.tasks={};self.cursors={};self.errors={}

    async def __aenter__(self):return self

    async def __aexit__(self,*_):await self.clear()

    async def clear(self):
        tasks=list(self.tasks)
        for task in tasks:task.cancel()
        if tasks:await asyncio.gather(*tasks,return_exceptions=True)
        self.tasks.clear();self.cursors.clear();self.errors.clear();self.key=None

    async def read(self,url,*,after=0,process='',shards=1,generation=0):
        shards=4 if shards==4 else 1;key=(url,process,shards,generation)
        if key!=self.key:await self.clear();self.key=key
        async def request(index):
            await asyncio.sleep(.25 if index in self.errors else .1)
            return await self.fetch(self.client,url,after=self.cursors.get(index,after),process=process,shard=index,shards=shards)
        while True:
            occupied=set(self.tasks.values())
            for index in range(shards):
                if index not in occupied:self.tasks[asyncio.create_task(request(index))]=index
            done,_=await asyncio.wait(self.tasks,return_when=asyncio.FIRST_COMPLETED)
            # Consume one completed response now. Other ready responses remain
            # queued; no barrier waits for all four shards or merges their clocks.
            # asyncio.wait returns an unordered set. Under sustained consumer
            # load, choosing an arbitrary member can repeatedly prefer newly
            # completed requests while an older ready shard waits indefinitely.
            # Dict insertion order gives ready requests bounded, fair service;
            # an older request still in flight never blocks completed shards.
            task=next(task for task in self.tasks if task in done)
            index=self.tasks.pop(task)
            try:body=task.result()
            except Exception as error:
                self.errors[index]=error
                if len(self.errors)==shards:raise error
                continue
            self.errors.pop(index,None)
            if shards>1:
                if body.get('shards')!=shards or body.get('shard')!=index or any('aircraft_sequence' not in p for p in body['packets']):
                    raise ValueError('Invalid parallel telemetry response')
            if body.get('latest_sequence') is not None:self.cursors[index]=body['latest_sequence']
            return body
