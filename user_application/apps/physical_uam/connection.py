"""Operator connection preferences; never owns or controls aircraft state."""
import asyncio
import time
import httpx
from communication.external.physical_link import PhysicalLink,validate_link


class PhysicalConnection:
    def __init__(self,files,defaults,process_id,local_port=8770):
        self.files=files;self.config=files.read('connection',defaults);self.process_id=process_id
        self.link=PhysicalLink(local_port);self.lock=asyncio.Lock();self.state='disconnected';self.message='연결 설정을 확인해 주세요.'
        self.check={};self.retry_at=0

    def describe(self):
        active=self.link.running
        config=self.config
        state=self.state if active or self.state!='connected' else 'disconnected'
        check=dict(self.check)
        if not active or time.time()-check.get('checked_at',0)>8:
            check['receiving']=False;check['twin_api']=False
        message=self.message if active or self.state!='connected' else 'SSH 연결이 끊겼습니다. 자동 연결 설정 또는 대상 PC를 확인해 주세요.'
        return {'settings':config,'status':state,'message':message,'tunnel_running':active,'diagnostics':check,
            'physical_url':f'http://127.0.0.1:{self.link.local_port}',
            'twin_url':f"http://{config.get('host','')}:{config.get('web_port',8766)}" if config.get('host') else None,
            'receiver_url':f"http://127.0.0.1:{config.get('forward_port',18770)}",
            'protocol':'HTTP/JSON · SSH 암호화 터널 · Twin이 약 0.1초 간격으로 조회'}

    async def diagnose(self):
        self.check={'checked_at':time.time(),'twin_api':False,'this_publisher':False,'receiving':False}
        try:
            before=time.monotonic();result=await self.link.request('/api/live/uam')
            self.check.update(twin_api=True,rtt_ms=round((time.monotonic()-before)*1000,1),
                source_url=result.get('source_url'),enabled=result.get('enabled'),simulation_suspended=result.get('simulation_suspended'))
            expected=f"http://127.0.0.1:{self.config['forward_port']}"
            deadline=time.monotonic()+4
            # A changed flight may leave older aircraft observations in the Twin.
            # Diagnose the freshest observation before any retained old mission.
            for item in sorted(result.get('aircraft',[]),key=lambda item:item.get('measurement_age_s',float('inf'))):
                if time.monotonic()>deadline:break
                detail=item if item.get('process_id') else await self.link.request('/api/live/uam/'+item['entity_id'])
                if detail.get('process_id')==(self.process_id() if callable(self.process_id) else self.process_id):
                    self.check.update(this_publisher=True,aircraft=item['name'],sequence=item['sequence'],measurement_age_s=item['measurement_age_s'])
                    break
            self.check['receiving']=bool(self.check['this_publisher'] and result.get('receiving') and result.get('status')=='ready' and self.check['measurement_age_s']<=2)
            current=self.process_id() if callable(self.process_id) else self.process_id
            self.check['received_aircraft']=sum(item.get('process_id')==current for item in result.get('aircraft',[]))
            self.check['fresh_aircraft']=sum(item.get('process_id')==current and item.get('measurement_age_s',999)<=2 for item in result.get('aircraft',[]))
            if self.check['receiving']:self.message='이 PC의 센서를 Twin이 수신 중입니다.'
            elif result.get('simulation_suspended'):self.message='터널 정상 · Twin이 Simulation 모드여서 수신을 쉬고 있습니다.'
            elif not result.get('enabled'):self.message='터널 정상 · Twin에서 UAM 수신을 켜 주세요.'
            elif result.get('source_url') and result['source_url']!=expected:self.message='터널 정상 · Twin의 센서 API 주소가 다릅니다. 적용 · 연결로 맞춰 주세요.'
            else:self.message='터널 정상 · 이 PC의 최신 센서 수신을 기다립니다. Play 상태를 확인해 주세요.'
            self.state='connected'
        except (httpx.HTTPError,ValueError,KeyError,TypeError):
            self.state='error';self.message='Twin 상태 확인 실패 · 연결 대상과 Twin 실행 상태를 확인해 주세요.'
        return self.describe()

    async def connect(self,value,*,persist=True):
        config=validate_link(value,check_key=True)
        async with self.lock:
            old=self.config.copy();had_link=self.link.running;prior_source=None;source_applied=False
            self.state='connecting';self.message='SSH 인증과 Twin API를 확인하고 있습니다.'
            try:
                if config!=self.config or not self.link.running:await self.link.connect(config)
                prior_source=(await self.link.request('/api/live/uam')).get('source_url')
                # Explicit operator action applies the loopback source on the selected Twin.
                await self.link.request('/api/live/uam/source',payload={'source_url':f"http://127.0.0.1:{config['forward_port']}"})
                source_applied=True
                if persist:self.files.save('connection',config)
                self.config=config
                return await self.diagnose()
            except (ValueError,OSError,httpx.HTTPError) as error:
                rollback_note=''
                if source_applied and prior_source:
                    try:await self.link.request('/api/live/uam/source',payload={'source_url':prior_source})
                    except (ValueError,httpx.HTTPError):rollback_note=' 대상 Twin의 이전 센서 주소 복구를 확인하지 못했습니다.'
                await self.link.close();self.config=old
                self.state='error';self.message=str(error) if isinstance(error,ValueError) else 'Twin 연결 설정 실패 · 대상 서버의 최신 연결 API와 실행 상태를 확인해 주세요.'
                if had_link:
                    try:await self.link.connect(old);self.message+=' 기존 터널은 복구했습니다.'
                    except ValueError:self.message+=' 기존 터널도 연결되지 않습니다.'
                self.retry_at=time.monotonic()+10
                self.message+=rollback_note
                raise ValueError(self.message) from error

    async def disconnect(self):
        async with self.lock:
            config=dict(self.config,auto_connect=False);self.files.save('connection',config);self.config=config
            await self.link.close();self.state='disconnected';self.message='연결 해제됨 · 이 PC의 비행과 센서 생성은 계속됩니다.';self.check={}
            return self.describe()

    async def suspend(self):
        """Launcher shutdown: close only our child; retain next-start preference."""
        async with self.lock:
            self.config=dict(self.config,auto_connect=False)
            await self.link.close();self.state='disconnected';self.check={}
            return self.describe()

    async def run(self):
        try:
            while True:
                if not self.lock.locked():
                    async with self.lock:
                        if self.link.running:await self.diagnose()
                        elif self.config.get('auto_connect') and time.monotonic()>=self.retry_at:
                            try:
                                # Automatic reconnect restores transport only; it never changes Twin settings.
                                self.state='connecting';await self.link.connect(self.config);await self.diagnose()
                            except ValueError as error:self.state='error';self.message=str(error);self.retry_at=time.monotonic()+10
                await asyncio.sleep(3)
        finally:await self.link.close()
