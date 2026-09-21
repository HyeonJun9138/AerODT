"""Past received UAM measurements, continuity and bounded input history."""
from collections import OrderedDict,deque
from copy import deepcopy
from contextlib import contextmanager
import threading


class UamSensorRecords:
    def __init__(self):
        self.lock=threading.RLock();self.latest=OrderedDict();self.history={}
        self.process='';self.started=-1.;self.sequence=0;self.generation=0
        self.accepted=0;self.missing=0;self.duplicates=0;self.rejected=0;self.coalesced=0;self.late_sensors=0

    def clear(self):
        with self.lock:
            self.latest.clear();self.history.clear();self.process='';self.started=-1.;self.sequence=0;self.generation+=1

    def register(self,packet,received,*,clock_offset_s=0.,clock_uncertainty_s=0.,unordered=False):
        with self.lock:
            if packet['process_id']!=self.process:
                if packet['source_started_at']<=self.started:self.duplicates+=1;return False
                self.latest.clear();self.history.clear();self.process=packet['process_id'];self.started=packet['source_started_at'];self.sequence=0;self.generation+=1
            key='physical:'+packet['aircraft_id'];old=self.latest.get(key)
            if (not unordered and packet['sequence']<=self.sequence) or (unordered and old and packet['sequence']<=old['packet']['sequence']):
                self.duplicates+=1;return False
            if unordered and old and packet['sent_time']<old['packet']['sent_time']:
                self.rejected+=1;return False
            if old and old['packet']['mission_id']==packet['mission_id']:
                if packet['sent_time']<old['packet']['sent_time']:
                    self.rejected+=1;return False
            if unordered:
                if old and old['packet']['mission_id']==packet['mission_id'] and 'aircraft_sequence' in old['packet']:
                    self.missing+=max(0,packet['aircraft_sequence']-old['packet']['aircraft_sequence']-1)
            elif self.sequence:self.missing+=max(0,packet['sequence']-self.sequence-1)
            self.sequence=max(self.sequence,packet['sequence']);self.accepted+=1
            continuity=(old['continuity']+1 if old else self.generation*100000) if not old or old['packet']['mission_id']!=packet['mission_id'] else old['continuity']
            if old and old['packet']['mission_id']!=packet['mission_id']:self.history.pop(key,None)
            record={'packet':deepcopy(packet),'received_time':received,'continuity':continuity,
                    'clock_offset_s':clock_offset_s,'clock_uncertainty_s':clock_uncertainty_s}
            # Preserve the raw packet and align each sensor independently.
            # Holding an earlier observation never changes its sample timestamp.
            prior_sensors=(old.get('aligned_sensors',old['packet']['sensors']) if old and old['packet']['mission_id']==packet['mission_id'] else {})
            aligned=dict(prior_sensors);late=[]
            for name,sensor in record['packet']['sensors'].items():
                prior=prior_sensors.get(name)
                if prior and (sensor['sample_time']<prior['sample_time'] or sensor['sequence']<prior['sequence']):late.append(name);continue
                aligned[name]=sensor
            self.late_sensors+=len(late)
            record['aligned_sensors']=aligned
            record['sensor_alignment']={'late':late,'held':sorted(set(prior_sensors)-set(packet['sensors']))}
            self.latest[key]=record;self.latest.move_to_end(key)
            # Raw sub-samples are already represented by this packet's latest
            # sensors. The navigation trail does not retain another IMU log.
            historical=dict(record,packet=dict(record['packet'],samples=[]))
            history=self.history.setdefault(key,deque(maxlen=400));history.append(historical)
            while history and packet['sent_time']-history[0]['packet']['sent_time']>40:history.popleft()
            while len(self.latest)>128:
                identifier,_=self.latest.popitem(last=False);self.history.pop(identifier,None)
            return True

    def read(self,entity_id=None):
        with self.lock:return deepcopy(self.latest.get(entity_id)) if entity_id else deepcopy(list(self.latest.items()))

    @contextmanager
    def borrow_for_estimation(self):
        """Internal synchronous read-only scope. Never retain or mutate these records.

        Estimation returns immutable entities and does not change input. Hold the
        data lock so ingestion cannot replace its inputs mid-pass; public readers
        still receive independent copies. Avoid copying routes/IMU logs at 10 Hz.
        """
        with self.lock:yield tuple(self.latest.items())

    def counters(self):
        with self.lock:return dict(accepted=self.accepted,missing_packets=self.missing,duplicates=self.duplicates,rejected=self.rejected,coalesced_packets=self.coalesced,late_sensors=self.late_sensors)

    def latest_observation_time(self):
        # Status needs one scalar, not copies of every sensor and route for
        # every independently arriving shard. Retain actual aligned sample time.
        with self.lock:
            return max((g['sample_time']+r.get('clock_offset_s',0) for r in self.latest.values()
                        if (g:=r.get('aligned_sensors',r['packet']['sensors']).get('gnss'))),default=0.)

    def account_coalesced(self,count,missing_before):
        with self.lock:
            self.coalesced+=count
            self.missing-=min(count,max(0,self.missing-missing_before))

    def past(self,entity_id):
        with self.lock:return deepcopy(list(self.history.get(entity_id,())))
