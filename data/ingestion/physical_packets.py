"""Bounded raw sensor packet log. Both HTTP reader and Twin consume copies."""
from collections import deque
from bisect import bisect_right
from copy import deepcopy
import threading
from zlib import crc32


class PhysicalPackets:
    def __init__(self, limit=2048):
        self.packets=deque(maxlen=limit);self.lock=threading.RLock();self.by_aircraft={}

    def append(self, packet):
        owned=deepcopy(packet)
        with self.lock:
            if len(self.packets)==self.packets.maxlen:
                old=self.packets[0];key=old.get('aircraft_id','');group=self.by_aircraft[key]
                group.popleft()
                if not group:del self.by_aircraft[key]
            self.packets.append(owned)
            self.by_aircraft.setdefault(owned.get('aircraft_id',''),deque()).append(owned)

    def clear(self):
        with self.lock:self.packets.clear();self.by_aircraft.clear()

    def read(self, after=0,aircraft_id=None,limit=256,latest_only=False,shard=0,shards=1):
        if not 1<=shards<=4 or not 0<=shard<shards:raise ValueError('Invalid telemetry shard')
        with self.lock:
            coalesced=0
            if latest_only:
                packets=[]
                # Index references only retained, owned log records. No raw
                # IMU copies or full-ring CRC scan on each latest-state poll.
                for key,group in self.by_aircraft.items():
                    if (aircraft_id and key!=aircraft_id) or (shards>1 and crc32(key.encode())%shards!=shard):continue
                    start=bisect_right(group,after,key=lambda p:p['sequence'])
                    if start==len(group):continue
                    coalesced+=len(group)-start-1
                    packets.append(dict(group[-1],samples=[]))
                packets.sort(key=lambda p:p['sequence'])
            else:
                packets=[p for p in self.packets if p['sequence']>after and (not aircraft_id or p['aircraft_id']==aircraft_id)
                         and (shards==1 or crc32(p['aircraft_id'].encode())%shards==shard)]
            page=packets[:limit] if after else packets[-limit:]
            result={'schema_version':1,'packets':page,
                    'shard':shard,'shards':shards,
                    'coalesced_packets':coalesced,'delivery':'latest' if latest_only else 'ordered',
                    'has_more':bool(after and len(packets)>limit),
                    'oldest_sequence':self.packets[0]['sequence'] if self.packets else None,
                    'latest_sequence':self.packets[-1]['sequence'] if self.packets else None}
        # The log never mutates owned packets. Retaining these references keeps
        # the selected generation alive after eviction without blocking append.
        result['packets']=deepcopy(page)
        return result
