"""Received/captured operational observations and durable analysis facts.

These are reports from the authoritative engine, never a second controller or
aircraft state. Configuration travels once per run; events travel by cursor.
"""
from copy import deepcopy
from bisect import bisect_right
import threading
from .operations_records import write_operations


class PhysicalOperationsRecords:
    def __init__(self,directory):
        self.directory=directory;self.lock=threading.RLock();self.checkpoint_lock=threading.Lock();self.started=-1.;self.clear()

    def clear(self):
        with self.lock:
            self.run_id='';self.process_id='';self.configuration=None;self.frame=None
            self.header=None;self.events=[];self.sequence=0;self.received=0.;self.generated_at=0.;self.complete=False
            self.last_event_sequence=0;self.observed_event_count=0;self.error=None

    def begin(self,run_id,process_id,started,configuration):
        with self.lock:
            self.clear();self.run_id=run_id;self.process_id=process_id;self.started=started
            self.configuration=deepcopy(configuration)

    def observe_events(self,events):
        with self.lock:
            # Engine inspection rings are ordered by sequence, including after
            # front eviction. Visit only new facts, not the whole ring per tick.
            start=bisect_right(events,self.last_event_sequence,key=lambda e:e['event_sequence'])
            for event in events[start:]:
                seq=event['event_sequence']
                if seq>self.last_event_sequence:
                    self.events.append(deepcopy(event));self.last_event_sequence=seq

    def observe(self,frame,header,now):
        with self.lock:
            self.frame=deepcopy(frame);self.header=deepcopy(header);self.sequence+=1
            self.received=now;self.generated_at=now;self.complete=True;self.observed_event_count=len(self.events)

    def envelope(self,run_id='',after=0,limit=1000):
        with self.lock:
            if self.frame is None:return {'schema_version':1,'available':False}
            start=after if run_id==self.run_id else 0
            count=self.observed_event_count
            if not 0<=start<=count:raise ValueError('Invalid operations cursor')
            end=min(count,start+limit)
            return deepcopy({'schema_version':1,'available':True,'run_id':self.run_id,
                'process_id':self.process_id,'source_started_at':self.started,'sequence':self.sequence,
                'generated_at':self.received,'frame':self.frame,'analysis':self.header,
                'configuration':self.configuration if run_id!=self.run_id else None,
                'events':self.events[start:end],'after':start,'next':end,'event_count':count,
                'has_more':end<count})

    def register(self,body,received):
        with self.lock:
            new=body['run_id']!=self.run_id
            if new:
                if body['source_started_at']<self.started:return False
                if body['configuration'] is None or body['after']!=0:raise ValueError('Missing operations bootstrap')
                self.begin(body['run_id'],body['process_id'],body['source_started_at'],body['configuration'])
            if body['process_id']!=self.process_id or body['sequence']<self.sequence:return False
            if body['after']!=len(self.events):raise ValueError('Non-contiguous operations history')
            if body['next']!=body['after']+len(body['events']):raise ValueError('Invalid operations event cursor')
            self.events.extend(deepcopy(body['events']))
            self.frame=deepcopy(body['frame']);self.sequence=body['sequence'];self.received=received;self.generated_at=body['generated_at']
            self.complete=not body['has_more']
            if self.complete:self.header=deepcopy(body['analysis']);self.observed_event_count=len(self.events)
            self.error=None
            return True

    def observation(self):
        with self.lock:
            return deepcopy(self.frame),self.received,self.run_id,self.sequence

    def analysis_input(self):
        with self.lock:
            if self.header is None or not self.complete:return None
            return deepcopy({**self.configuration['analysis_base'],**self.header,'events':self.events[:self.observed_event_count]})

    def checkpoint(self):
        if not self.directory:return True
        # Captured facts are privately copied at ingestion and replaced, never
        # edited. A shallow snapshot pins this immutable generation for the
        # writer; public analysis_input() still returns independent deep copies.
        with self.checkpoint_lock:
            with self.lock:
                if self.header is None or not self.complete:return True
                source={**self.configuration['analysis_base'],**self.header,
                        'events':self.events[:self.observed_event_count]}
                run_id=self.run_id
            try:write_operations(self.directory/source['meta']['scenario_id'],source)
            except (OSError, ValueError, TypeError) as error:
                with self.lock:
                    if self.run_id==run_id:self.error=f'{type(error).__name__}: {error}'
                return False
            with self.lock:
                if self.run_id==run_id:self.error=None
            return True
