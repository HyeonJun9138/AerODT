"""Owned SSH forwarding and bounded HTTP diagnostics for a Physical publisher."""
import asyncio
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import httpx


def validate_link(value, *, check_key=False):
    if not isinstance(value,dict):raise ValueError('연결 설정은 객체여야 합니다.')
    result={'schema_version':1}
    for name,label,pattern in [('host','Twin PC 주소',r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}'),
                               ('username','SSH 사용자',r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}')]:
        text=str(value.get(name,'')).strip()
        if not re.fullmatch(pattern,text):raise ValueError(label+'를 확인해 주세요.')
        result[name]=text
    for name,default,minimum in [('ssh_port',22,1),('web_port',8766,1),('forward_port',18770,1024)]:
        number=value.get(name,default)
        if isinstance(number,bool) or not isinstance(number,int) or not minimum<=number<=65535:
            raise ValueError(name+' 포트 범위를 확인해 주세요.')
        result[name]=number
    if result['forward_port'] in (result['ssh_port'],result['web_port']):
        raise ValueError('터널 센서 포트는 SSH·Twin 웹 포트와 달라야 합니다.')
    key=str(value.get('identity_file','')).strip()
    if not key or len(key)>1000 or any(ord(c)<32 for c in key):raise ValueError('이 PC의 SSH 개인 키 파일 경로를 입력해 주세요.')
    if check_key and not Path(key).expanduser().is_file():raise ValueError('이 PC에서 SSH 키 파일을 찾을 수 없습니다.')
    result['identity_file']=key
    if not isinstance(value.get('auto_connect',True),bool):raise ValueError('자동 연결 값을 확인해 주세요.')
    result['auto_connect']=value.get('auto_connect',True)
    return result


def ssh_arguments(config,local_port,control_port):
    return ['ssh','-N','-T','-i',str(Path(config['identity_file']).expanduser()),'-p',str(config['ssh_port']),
        '-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
        '-o','ConnectTimeout=6','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',
        '-R',f"127.0.0.1:{config['forward_port']}:127.0.0.1:{local_port}",
        '-L',f"127.0.0.1:{control_port}:127.0.0.1:{config['web_port']}",f"{config['username']}@{config['host']}"]


def ssh_failure(message):
    if 'Host key verification failed' in message:return 'SSH 서버 지문이 등록되지 않았거나 변경됐습니다. 이 PC에서 해당 서버의 SSH 접속을 먼저 확인해 주세요.'
    if 'Permission denied' in message:return 'SSH 인증 실패 · 사용자와 개인 키, 서버의 공개 키 등록을 확인해 주세요.'
    if 'forwarding failed' in message or 'Address already in use' in message:return '터널 포트가 사용 중입니다. 기존 연결 또는 터널 포트를 확인해 주세요.'
    return 'SSH 연결 실패 · PC 주소, SSH 포트와 네트워크를 확인해 주세요.'


class PhysicalLink:
    def __init__(self,local_port=8770):
        self.local_port=local_port;self.process=None;self.reader=None;self.control_port=None;self.error='';self.config=None

    @property
    def running(self):return self.process is not None and self.process.returncode is None

    @property
    def control_url(self):return f'http://127.0.0.1:{self.control_port}' if self.running else None

    async def connect(self,config):
        config=validate_link(config,check_key=True)
        await self.close();self.error='';self.config=config
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));self.control_port=sock.getsockname()[1]
        flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
        try:
            self.process=await asyncio.create_subprocess_exec(*ssh_arguments(config,self.local_port,self.control_port),
                stdin=asyncio.subprocess.DEVNULL,stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.PIPE,creationflags=flags)
            async def read_error():
                while True:
                    line=await self.process.stderr.readline()
                    if not line:return
                    self.error=(self.error+line.decode('utf-8',errors='replace'))[-4096:]
            self.reader=asyncio.create_task(read_error())
            # A remote authenticated command round trip is deliberately not used.
            # The forwarded Twin API confirms SSH authentication AND both forwards.
            deadline=time.monotonic()+8
            while time.monotonic()<deadline:
                if not self.running:raise ValueError(ssh_failure(self.error))
                try:
                    await self.request('/api/live/uam');return
                except (httpx.HTTPError,ValueError):await asyncio.sleep(.15)
            raise ValueError('SSH 연결 후 Twin API에 닿지 못했습니다. Twin 웹 포트와 실행 상태를 확인해 주세요.')
        except (OSError,ValueError) as error:
            await self.close()
            raise ValueError(str(error) if isinstance(error,ValueError) else '이 PC에서 SSH 프로그램을 실행할 수 없습니다.') from error

    async def request(self,path,*,payload=None):
        if not self.control_url:raise ValueError('SSH 연결이 열려 있지 않습니다.')
        async with httpx.AsyncClient(trust_env=False,follow_redirects=False,timeout=2) as client:
            response=await client.request('PUT' if payload is not None else 'GET',self.control_url+path,json=payload)
            response.raise_for_status()
            value=response.json()
            if not isinstance(value,dict):raise ValueError('Twin API 응답 형식이 올바르지 않습니다.')
            return value

    async def close(self):
        if self.running:
            self.process.terminate()
            try:await asyncio.wait_for(self.process.wait(),3)
            except asyncio.TimeoutError:self.process.kill();await self.process.wait()
        if self.reader:
            await asyncio.gather(self.reader,return_exceptions=True)
        self.process=None;self.reader=None;self.control_port=None
