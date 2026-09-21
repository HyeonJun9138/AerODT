"""A busy consumer must drain already-ready shards before newer requests."""
import asyncio
from unittest.mock import patch
from communication.external.physical_polls import PhysicalPolls


def test_ready_shards_cannot_be_starved_by_newer_completions():
    async def run():
        async def fetch(client,url,*,shard,shards,**kw):
            return {'packets':[{'aircraft_sequence':1}], 'shard':shard,
                    'shards':shards,'latest_sequence':1}
        real_wait=asyncio.wait
        async def newest_first(tasks,**kw):
            # Simulate a busy consumer: every request has completed by the time
            # it can inspect responses. asyncio's done set promises no order.
            await real_wait(list(tasks),return_when=asyncio.ALL_COMPLETED)
            return list(reversed(list(tasks))),set()
        async with PhysicalPolls(None,fetch) as polls:
            with patch('communication.external.physical_polls.asyncio.wait',newest_first):
                batches=[await polls.read('test',shards=4) for _ in range(8)]
            assert [b['shard'] for b in batches]==[0,1,2,3,0,1,2,3]
    asyncio.run(run())
