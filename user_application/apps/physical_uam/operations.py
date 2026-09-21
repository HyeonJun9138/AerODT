"""Capture actual fleet operations using the same read views as Simulation."""
import time
from collections import defaultdict,deque
from datetime import datetime,timezone,timedelta
from user_application.uam_mission.scenario_observation import ScenarioObservation
from user_application.uam_mission.operations_analysis import capture
from user_application.uam_mission.operating_revision import operating_revision,digest


STATES={'running':'playing','waiting':'ready','preparing':'ready','landed':'finished','paused':'paused','stopped':'finished','error':'paused'}


class FleetObservation(ScenarioObservation):
    def __init__(self,fleet,states):
        # Borrow only for this capture, after the native worker has completed.
        self.engine=fleet.engine;self.state=STATES.get(fleet.status['status'],'ready')
        self.states={s['aircraft_id']:s for s in states}
        self.flight_events=defaultdict(lambda:deque(maxlen=20))
        for event in self.engine.events:self.flight_events[event['flight_id']].append(event)

    def state_for(self,aircraft):return self.states[aircraft.aircraft_id]

    def flight_detail_for(self,flight_id):
        flight=self.engine.flights.get(flight_id)
        if flight is None:return None
        clearance=self.engine.psu.clearance(flight_id)
        return {'flight':dict(flight),'clearance':clearance.as_dict() if clearance else None,
                'events':list(self.flight_events.get(flight_id,()))}


def configuration(fleet):
    analysis=capture(fleet.engine,fleet.active['schedule'],fleet.operation_run,events=[])
    return {'environment':fleet.active['environment'],'policy':fleet.engine.policy,'profile':fleet.active['profile'],
        'execution':{k:fleet.active['settings'].get(k) for k in ('terrain','flat_height_m','time_mode','start_at','seed','repeat')},
        'profile_revision':digest(fleet.active['profile']),
        'rules':operating_revision(),'policy_revision':digest(fleet.engine.policy),
        'environment_revision':digest(fleet.active['environment']),
        'analysis_base':{k:v for k,v in analysis.items() if k not in ('events','active','meta')}}


def capture_frame(fleet):
    states=fleet.engine.states();view=FleetObservation(fleet,states);now=time.time()
    schedule=fleet.active['schedule'];summary=fleet.engine.summary();run_id=fleet.operation_run
    meta={'scenario_id':run_id,'schedule_id':schedule.get('schedule_id'),'name':schedule.get('name') or 'Physical 운항',
        'date':schedule.get('date',''),'state':view.state,'observed_s':fleet.engine.time_s,
        'start_s':fleet.engine.opens_s,'planned_end_s':fleet.engine.closes_s,'engine':'native',
        'source':'physical','source_label':'Physical 실시간 운항','legacy':False,'problem_count':schedule.get('problem_count',0),
        'reconstructed_through_s':getattr(fleet,'reconstructed_through_s',None)}
    header={'meta':meta,'active':{a.flight['flight_id']:{'hold_s':a.hold_seconds,'phase':a.phase,'failed':a.failed}
        for a in fleet.engine.aircraft.values() if a.flight}}
    midnight=datetime.fromisoformat(schedule['date']).replace(tzinfo=timezone(timedelta(hours=9))).timestamp()
    status={'schema_version':1,'loaded':True,'control_open':True,'read_only':True,'source':'physical',
        'source_label':'Physical 실시간 운항','state':view.state,'publisher_state':fleet.status['status'],
        'scenario_id':run_id,'name':meta['name'],'date':meta['date'],'epoch_time':midnight+fleet.engine.time_s,
        'speed':fleet.overview.get('real_time_factor',1),'speeds':[],
        'source_recording_error':fleet.operation_records.error,**summary}
    ports={key:view.vertiport(key) for key in fleet.engine._vertiports}
    frame={'status':status,'vertiports':view.vertiport_summary(),'decks':ports,'pilots':view.pilot_operations(),
        'aircraft':{key:view.aircraft(key) for key in fleet.engine.aircraft},'passengers':view.passengers(),
        'holds':fleet.engine.psu.holds()}
    fleet.operation_records.observe(frame,header,now)
