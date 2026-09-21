"""Independent operational input: reported decisions, facilities and history."""
import asyncio
import time
from copy import deepcopy
import httpx
from communication.external.physical_operations import fetch_operations
from data.simulation.physical_operations import PhysicalOperationsRecords
from digital_twin.model_library.vertiport_layout import validate_definition,generate_layout


class PhysicalOperations:
    def __init__(self,physical,directory):
        self.physical=physical;self.records=PhysicalOperationsRecords(directory);self.key=None
        self.state='connecting';self.error=None;self.facilities=[];self.configuration_revision=None

    @property
    def selected(self):
        p=self.physical
        return bool(p.url and p.enabled() and not p.simulation_showing())

    @property
    def collecting(self):return bool(self.physical.url and self.physical.enabled())

    async def run(self):
        saved_at=0.
        async with httpx.AsyncClient(trust_env=False,follow_redirects=False) as client:
            while True:
                try:
                    p=self.physical;key=(p.url,p.generation)
                    if key!=self.key:
                        await asyncio.to_thread(self.records.checkpoint)
                        self.records.clear();self.records.started=-1.;self.facilities=[];self.key=key
                    if not self.collecting:
                        self.state='paused';await asyncio.sleep(.5);continue
                    body=await fetch_operations(client,p.url,self.records.run_id,len(self.records.events))
                    if key!=(p.url,p.generation) or not self.collecting:continue
                    if not body['available']:
                        self.state='unavailable';await asyncio.sleep(1);continue
                    if self.selected and p.clock_process and body['process_id']!=p.clock_process:
                        self.state='connecting';await asyncio.sleep(.25);continue
                    config=body.get('configuration')
                    facilities=None
                    if config is not None:
                        facilities=[]
                        for record in config['environment']['vertiports']:
                            definition=validate_definition(record);definition['id']=record['id']
                            facilities.append(dict(definition,layout=generate_layout(definition)))
                    if body['run_id']!=self.records.run_id:
                        await asyncio.to_thread(self.records.checkpoint)
                    if not self.records.register(body,time.time()):continue
                    if facilities is not None:self.facilities=facilities;self.configuration_revision=config.get('environment_revision')
                    self.state='syncing' if body['has_more'] else 'ready';self.error=None
                    if time.monotonic()-saved_at>=5 and self.records.complete:
                        await asyncio.to_thread(self.records.checkpoint);saved_at=time.monotonic()
                    await asyncio.sleep(.02 if body['has_more'] else 1)
                except asyncio.CancelledError:
                    await asyncio.to_thread(self.records.checkpoint);raise
                except Exception as error:
                    self.state='error';self.error=type(error).__name__
                    await asyncio.sleep(1)

    def status(self):
        with self.records.lock:
            reported=deepcopy((self.records.frame or {}).get('status',{}))
            received=self.records.received;run_id=self.records.run_id;sequence=self.records.sequence
        age=max(0,time.time()-received,time.time()-self.records.generated_at-self.physical.clock_offset) if received else None
        if received and reported.get('publisher_state')=='paused':age=max(0,time.time()-received)
        stale=self.state!='ready' or age is None or age>4
        return {**(reported or {'loaded':False,'state':'idle','control_open':False}),
            'source':'physical','source_label':'Physical 실시간 운항','read_only':True,
            'receiving':self.collecting,'sync_state':self.state,'stale':stale,'age_s':age,
            'operation_run_id':run_id,'operation_sequence':sequence,'recording_error':self.records.error,
            'history_complete':self.records.complete,'event_count':len(self.records.events)}

    def read(self,name,identifier=None):
        with self.records.lock:
            if self.records.frame is None:return None
            value=self.records.frame.get(name)
            if identifier is not None:value=(value or {}).get(str(identifier).split(':',1)[-1])
            value=deepcopy(value)
        if isinstance(value,dict):value={**value,**{k:v for k,v in self.status().items() if k in ('source','source_label','stale','age_s','operation_run_id','read_only','sync_state')}}
        return value

    def configuration(self,*keys):
        with self.records.lock:
            config=self.records.configuration
            return deepcopy({k:config[k] for k in keys if k in config} if keys and config is not None else config)

    def analysis_input(self):
        source=self.records.analysis_input()
        if source:source['meta'].update(sync_state=self.state,stale=self.status()['stale'],source='physical',source_label='Physical 실시간 운항')
        return source

    def analysis_cache_key(self):return ('physical',self.records.run_id,self.state)

    def analysis_stamp(self):return ('physical',self.records.run_id,self.records.sequence,self.state)
