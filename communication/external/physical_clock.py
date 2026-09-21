"""Periodic clock calibration without holding up independent telemetry pulls."""
import asyncio
import time
from .physical_uam import sample_clock


class PhysicalClock:
    def __init__(self,client,probe=sample_clock,interval=3.):
        self.client=client;self.probe=probe;self.interval=interval
        self.key=None;self.task=None;self.value=None;self.next_probe=0.

    async def clear(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task,return_exceptions=True)
        self.key=None;self.task=None;self.value=None;self.next_probe=0.

    async def __aenter__(self):return self
    async def __aexit__(self,*_):await self.clear()

    def accept(self,sample):
        low=sample['requested']-sample['source_time'];high=sample['received']-sample['source_time']
        previous=self.value;offset=previous['offset_s'] if previous else (low+high)/2
        # Network delay gives an interval, not evidence of clock movement.
        # Keep a mapping already inside it, so ordinary jitter cannot retime a
        # held observation. A confirmed clock shift uses the new midpoint.
        if not low-.002<=offset<=high+.002:offset=(low+high)/2
        uncertainty=max(abs(offset-low),abs(high-offset))
        self.value=dict(offset_s=offset,uncertainty_s=uncertainty,
                        sampled_at=sample['received'],telemetry_shards=sample.get('telemetry_shards',1),
                        corrections=(previous['corrections']+int(abs(offset-previous['offset_s'])>.002)) if previous else 0)

    async def read(self,url,process,generation=0):
        key=(url,process,generation)
        if key!=self.key:await self.clear();self.key=key
        if self.task is None and (self.value is None or time.monotonic()>=self.next_probe):
            self.task=asyncio.create_task(self.probe(self.client,url,process))
        if self.value is None or self.task and self.task.done():
            task=self.task
            try:
                sample=await task
                self.accept(sample)
                self.next_probe=time.monotonic()+self.interval
            except asyncio.CancelledError:raise
            except Exception:
                self.next_probe=time.monotonic()+1.
                if self.value is None:raise
            finally:self.task=None
        return self.value
