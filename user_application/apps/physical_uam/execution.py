"""Switch complete execution contexts; a mode change never mixes sensor epochs."""
import asyncio
from digital_twin.model_library.sensor_calibration import validate_profile,PROFILES
from .flight import PhysicalFlight
from .fleet import PhysicalFleet


class PhysicalExecution:
    def __init__(self,library,packets,model,saved,console,*,physics_workers=None,**options):
        self.physics_workers=physics_workers
        self.library=library;self.packets=packets;self.model=model;self.saved=saved;self.console=console;self.options=options
        self.current=PhysicalFlight(library,packets,model,saved,**options);self.task=None;self.commands=asyncio.Queue(maxsize=5);self.logger=None
    @property
    def process_id(self):return self.current.process_id
    @property
    def status(self):return dict(self.current.status,scope='fleet' if isinstance(self.current,PhysicalFleet) else 'single',
        sensor_profile=self.model.get('sensor_profile','stochastic'),sensor_profiles=list(PROFILES))

    def set_sensor_profile(self,value):
        # A sensor-only mode change: keep native World, mission, clocks and sequences.
        self.model['sensor_profile']=validate_profile(value)
        if self.logger:self.logger.log('sensor_profile_changed',self.status.get('mission_id',''),data={'sensor_profile':value})
        return {'sensor_profile':value,'applies':'next_sensor_sample','flight_restarted':False}
    @property
    def truth(self):return self.current.truth
    def plan(self):return self.current.active.get('saved') or {'schema_version':1,'scope':'fleet','schedule':self.current.active.get('schedule')}
    def operations(self):return dict(getattr(self.current,'overview',{}) or {'scope':'single','aircraft':[]},status=self.status['status'])
    def operations_snapshot(self,run_id='',after=0):
        return self.current.operation_records.envelope(run_id,after) if isinstance(self.current,PhysicalFleet) else {'schema_version':1,'available':False,'scope':'single'}
    def command(self,action,prepared=None):
        if self.commands.full():return False
        self.commands.put_nowait((action,prepared));return True
    async def cancel(self):
        if self.task:
            self.task.cancel();await asyncio.gather(self.task,return_exceptions=True);self.task=None
    async def run(self):
        try:
            while True:
                action,prepared=await self.commands.get()
                if action=='stop':
                    await self.cancel();self.current.status.update(status='stopped',phase=None,error=None)
                    self.current.truth.clear();self.packets.clear();continue
                if action in ('start','restart'):
                    prepared=prepared or self.current.active
                    await self.cancel();self.packets.clear()
                    self.current=(PhysicalFleet(self.library,self.packets,self.model,self.console,physics_workers=self.physics_workers) if prepared['settings'].get('scope')=='fleet'
                        else PhysicalFlight(self.library,self.packets,self.model,prepared['saved'],**self.options))
                    self.current.logger=self.logger
                    self.current.command('start',prepared)
                else:self.current.command(action,prepared)
                if self.task is None:self.task=asyncio.create_task(self.current.run())
        finally:await self.cancel()
