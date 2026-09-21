"""Physical UAM desktop console and sensor API."""
import argparse
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import time
import uvicorn
from fastapi import FastAPI
from starlette.middleware.gzip import GZipMiddleware
from communication.python.native_pilot import NativePilotLibrary
from communication.web.domains.uam.physical_publisher_routes import create_publisher_router
from communication.web.domains.uam.physical_console_routes import create_console_router
from data.ingestion.physical_packets import PhysicalPackets
from data.python.aerodt.data.run_logger import RunLogger
from .console import PhysicalConsole,validate_saved
from .execution import PhysicalExecution
from .connection import PhysicalConnection
from digital_twin.model_library.sensor_calibration import validate_profile

ROOT=Path(__file__).resolve().parents[3]
MODEL=ROOT/'digital_twin/model_library/packages/physical_uam_sensors/v1/model.json'


def create_app(flight_path, *, repeat=True,seed=42,autostart=True,workspace=None,port=8770,physics_workers=None):
    saved=validate_saved(json.loads(Path(flight_path).read_text(encoding='utf-8-sig')))
    model=json.loads(MODEL.read_text(encoding='utf-8'))
    workspace=Path(workspace or ROOT/'data/workspace')
    console=PhysicalConsole(workspace,saved);packets=PhysicalPackets()
    model['sensor_profile']=validate_profile(console.files.read('sensor_profile',{'profile':'stochastic'}).get('profile'))
    flight=PhysicalExecution(NativePilotLibrary(),packets,model,saved,console,repeat=repeat,seed=seed,physics_workers=physics_workers)
    defaults=json.loads((ROOT/'user_application/configs/physical_uam/connection.json').read_text(encoding='utf-8'))
    connection=PhysicalConnection(console.files,defaults,lambda:flight.process_id,port)
    @asynccontextmanager
    async def lifespan(app):
        logger=RunLogger(workspace,'physical_uam',{'process_id':flight.process_id,'console_version':3})
        flight.logger=logger
        if autostart:
            settings=console.files.read('settings',{})
            if settings.get('scope')=='fleet':flight.command('start',await asyncio.to_thread(console.prepare,settings))
            else:flight.command('restart')
        task=asyncio.create_task(flight.run())
        link_task=asyncio.create_task(connection.run())
        try:yield
        finally:
            task.cancel();link_task.cancel();await asyncio.gather(task,link_task,return_exceptions=True)
            logger.finish('error' if flight.status['status']=='error' else 'stopped',flight.status.get('error'))
    app=FastAPI(title='AerODT Physical UAM Console',lifespan=lifespan)
    app.add_middleware(GZipMiddleware,minimum_size=1000,compresslevel=1)
    app.state.flight=flight;app.state.console=console
    def telemetry(after,process,aircraft_id=None,delivery='ordered',shard=0,shards=1):
        return dict(packets.read(after if process==flight.process_id else 0,aircraft_id,latest_only=delivery=='latest',shard=shard,shards=shards),process_id=flight.process_id,server_time=time.time())
    def launch(prepared):
        if flight.commands.full():return False
        console.commit(prepared)
        return flight.command('start',prepared)
    def set_sensor_profile(value):
        value=validate_profile(value)
        console.files.save('sensor_profile',{'profile':value})
        return flight.set_sensor_profile(value)
    app.include_router(create_publisher_router(status=lambda:dict(flight.status,server_time=time.time(),telemetry_shards=4 if flight.status['scope']=='fleet' else 1,operations_version=1),telemetry=telemetry,operations=flight.operations_snapshot,
        plan=flight.plan,truth=lambda:dict(flight.truth,provenance='validation_only_ground_truth'),control=flight.command,sensor_profile=set_sensor_profile,
        page=lambda:Path(__file__).with_name('index.html').read_text(encoding='utf-8')))
    app.include_router(create_console_router(console,launch,Path(__file__).parent,connection=connection,operations=flight.operations))
    return app


def main():
    parser=argparse.ArgumentParser(description='AerODT Physical UAM sensor publisher')
    parser.add_argument('--flight',required=True);parser.add_argument('--port',type=int,default=8770)
    parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--once',action='store_true');parser.add_argument('--seed',type=int,default=42)
    parser.add_argument('--idle',action='store_true',help='Open the console without starting a flight')
    parser.add_argument('--physics-workers',type=int,choices=range(1,9),default=None,
                        help='Independent native pilot workers; shared operational decisions remain ordered')
    args=parser.parse_args()
    uvicorn.run(create_app(args.flight,repeat=not args.once,seed=args.seed,autostart=not args.idle,port=args.port,physics_workers=args.physics_workers),host=args.host,port=args.port,access_log=False)

if __name__=='__main__':main()
