"""Select the observed operating source without changing simulation controls."""
from copy import deepcopy
from digital_twin.model_library import route_network,uam_operating_profile
from digital_twin.simulation import decision_policy
from user_application.uam_mission.operating_revision import operating_revision,digest
from user_application.uam_mission.operations_reports import OperationsReports


class OperatingContext:
    def __init__(self,scenario,physical,ports,network,revision,decisions,profile):
        self.scenario=scenario;self.physical=physical;self.ports=ports;self.network=network
        self.local_revision=revision;self.decisions=decisions;self.profile=profile;self.rules=operating_revision()

    def status(self):
        if not self.physical.selected:return dict(self.scenario.status(),source='scenario',source_label='Simulation',read_only=False)
        status=self.physical.status();config=self.physical.configuration('rules','policy','profile','environment_revision','execution') or {}
        return dict(status,environment_revision=config.get('environment_revision'),
            rule_revision=(config.get('rules') or {}).get('revision'),local_rule_revision=self.rules['revision'],
            rules_match=(config.get('rules') or {}).get('revision')==self.rules['revision'] if config else None,
            policy_match=decision_policy.validate(self.decisions.read())==decision_policy.validate(config.get('policy')) if config else None,
            profile_match=uam_operating_profile.validate(self.profile.read())==uam_operating_profile.validate(config.get('profile')) if config else None,
            execution=config.get('execution'))

    def environment(self):
        if self.physical.selected:
            config=self.physical.configuration('environment','environment_revision') or {}
            # A configured Physical endpoint is selected before its first
            # operating envelope arrives.  Do not replace the saved UAM map
            # with an empty ``physical::pending`` environment during that
            # interval: keep the editable scenario infrastructure visible,
            # then switch atomically when the sender supplies its environment.
            if config.get('environment') is not None:
                environment=config['environment'] or {};ports=deepcopy(self.physical.facilities);routes=environment.get('routes') or {}
                return {'source':'physical','revision':self.environment_stamp()['revision'],
                    'vertiports':ports,'network':route_network.network(routes.get('nodes',[]),routes.get('links',[]),ports),
                    'segments':route_network.describe_options()['segments'],'read_only':True}
        return {'source':'scenario','revision':self.local_revision()['revision'],'vertiports':self.ports(),
            'network':self.network(),'segments':route_network.describe_options()['segments'],'read_only':False}

    def environment_stamp(self):
        if self.physical.selected and self.physical.configuration('environment'):
            return {'revision':'physical:'+self.physical.records.run_id+':'+str(self.physical.configuration_revision or 'pending')}
        return self.local_revision()

    def read(self,name,identifier=None):
        if self.physical.selected:
            value=self.physical.read(name,identifier)
            if name=='vertiports' and value is not None:
                value['facilities']={p['id']:p.get('name',p['id']) for p in self.physical.facilities}
            return value
        methods={'vertiports':'vertiport_summary','decks':'vertiport','pilots':'pilot_operations','aircraft':'aircraft','passengers':'passengers','holds':'holds'}
        method=getattr(self.scenario,methods[name]);value=method(identifier) if identifier is not None else method()
        if isinstance(value,dict):value=dict(value,source='scenario',source_label='Simulation',read_only=False)
        return value

    def rule_description(self):
        config=self.physical.configuration('policy') if self.physical.selected else None
        if self.physical.selected and not config:return None
        result=decision_policy.describe(config['policy'] if config else self.decisions.read())
        result.update(read_only=bool(config),applies_to='Physical 현재 운항 · 송신 PC에서 조정' if config else '다음 재생')
        return result

    def profile_description(self):
        config=self.physical.configuration('profile') if self.physical.selected else None
        if self.physical.selected and not config:return None
        result=uam_operating_profile.describe(config['profile'] if config else self.profile.read())
        if config:result.update(read_only=True,source='Physical 현재 운항에 적용된 속도',not_taken='송신 PC에서 설정한 실제 운항 값입니다.')
        return result


class OperatingReports:
    def __init__(self,context,simulation_records,physical_records):
        self.context=context
        self.simulation=OperationsReports(context.scenario,simulation_records)
        self.physical=OperationsReports(context.physical,physical_records)

    def target(self,recording):
        if recording=='current':return (self.physical if self.context.physical.selected else self.simulation),'current'
        if recording=='physical':return self.physical,'current'
        if recording=='simulation':return self.simulation,'current'
        if recording.startswith('physical:'):return self.physical,recording.split(':',1)[1]
        return self.simulation,recording

    def records_list(self):
        return {'schema_version':1,'current_source':'physical' if self.context.physical.selected else 'scenario',
            'records':[dict(r,id='physical:'+r['id'],source='physical',name='Physical · '+r.get('name','운항 기록')) for r in self.physical.records.list()]+self.simulation.records.list()}

    def summary(self,recording='current'):
        report,key=self.target(recording);return report.summary(key)
    def sorties(self,recording='current',**filters):
        report,key=self.target(recording);return report.sorties(key,**filters)
    def sortie(self,flight_id,recording='current'):
        report,key=self.target(recording);return report.sortie(flight_id,key)
    def export(self,recording='current'):
        report,key=self.target(recording);return report.export(key)
