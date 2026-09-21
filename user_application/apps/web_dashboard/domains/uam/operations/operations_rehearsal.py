"""One process-local collaboration exercise; never owns or edits vehicle state."""
import copy
import secrets
import time


class RehearsalError(ValueError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


class OperationsRehearsal:
    def __init__(self, vertiports, clock=time.time, audit=None):
        self.vertiports, self.clock = vertiports, clock
        self.audit = audit or (lambda *args, **kwargs: None)
        self.room_id = secrets.token_hex(6)
        self.revision, self.sessions, self.requests, self.history = 0, {}, [], []

    def prune(self):
        self.sessions = {k: v for k, v in self.sessions.items() if self.clock()-v['seen'] < 90}

    def facilities(self):
        return {r['id']: r.get('name', r['id']) for r in self.vertiports()}

    def join(self, name, role, facility_id=None, old_token=None):
        self.prune()
        if role not in ('psu', 'vertiport'):
            raise RehearsalError(422, '지원하지 않는 역할입니다.')
        if role == 'vertiport' and facility_id not in self.facilities():
            raise RehearsalError(422, '담당 버티포트를 선택해 주세요.')
        if old_token in self.sessions:
            del self.sessions[old_token]
        if len(self.sessions) >= 64:
            raise RehearsalError(429, '연습 접속 인원이 가득 찼습니다.')
        token = secrets.token_urlsafe(24)
        member = dict(id=secrets.token_hex(5), name=name.strip() or '운영자', role=role,
                      facility_id=facility_id if role == 'vertiport' else None, seen=self.clock())
        self.sessions[token] = member
        self.revision += 1
        return dict(token=token, member=self.public_member(member), room_id=self.room_id)

    def leave(self, token):
        """Give up a role. Idempotent: a token that is already gone - expired, or
        left from another tab - is not an error, because the operator's intent,
        to stop being the PSU, is satisfied either way. The seat is freed at once
        rather than lingering for the prune window, so the next person sees it."""
        self.prune()
        if token in self.sessions:
            del self.sessions[token]
            self.revision += 1
        return self.snapshot()

    @staticmethod
    def public_member(member):
        return {k: v for k, v in member.items() if k != 'seen'}

    def member(self, token):
        self.prune()
        if token not in self.sessions:
            raise RehearsalError(401, '연습 접속이 만료되었습니다. 역할로 다시 입장해 주세요.')
        member = self.sessions[token]
        member['seen'] = self.clock()
        return member

    def snapshot(self, token=None):
        self.prune()
        member = self.member(token) if token else None
        return copy.deepcopy(dict(schema_version=1, scope='shared_rehearsal', room_id=self.room_id,
            revision=self.revision, server_time=self.clock(), member=self.public_member(member) if member else None,
            participants=[self.public_member(v) for v in self.sessions.values()],
            requests=self.requests, history=self.history, facilities=self.facilities(),
            capabilities=dict(vehicle_control=False, authenticated_roles=False, shared_replay=False)))

    def add(self, member, facility_id, kind, callsign, note):
        if len(self.requests) >= 200:
            raise RehearsalError(409, '연습 요청 200건 한도입니다. 서버 재시작 시 초기화됩니다.')
        request = dict(id=secrets.token_hex(6), version=1, facility_id=facility_id, kind=kind,
                       callsign=callsign, note=note, state='pending', created_at=self.clock(),
                       author=member['name'], response='', responder='', updated_at=self.clock())
        self.requests.append(request)
        self.audit('rehearsal_request', scope='shared_rehearsal', room_id=self.room_id,
                   actor=self.public_member(member), request=request,
                   correlation_id=self.room_id + ':' + request['id'])
        self.revision += 1
        return request

    def seed(self, token):
        member = self.member(token)
        if member['role'] != 'psu':
            raise RehearsalError(403, 'PSU 역할에서 예시를 추가해 주세요.')
        facilities = list(self.facilities())[:3]
        if not facilities:
            raise RehearsalError(409, '먼저 버티포트를 저장해 주세요.')
        if any(r['kind'] != 'facility_report' for r in self.requests):
            raise RehearsalError(409, '이미 공유된 예시 요청이 있습니다.')
        if len(self.requests)+len(facilities)*2 > 200:
            raise RehearsalError(409, '연습 요청 한도를 초과합니다.')
        for i, facility in enumerate(facilities):
            self.add(member, facility, 'departure', f'DEMO {101+i*2}', '출발 순서 검토 예시 · 실제 비행계획 아님')
            self.add(member, facility, 'arrival', f'DEMO {102+i*2}', '접근 요청 예시 · FATO 수용 여부 확인 필요')

    def report(self, token, facility_id, note):
        member = self.member(token)
        if member['role'] != 'vertiport' or member['facility_id'] != facility_id:
            raise RehearsalError(403, '본인 담당 버티포트만 보고할 수 있습니다.')
        if facility_id not in self.facilities():
            raise RehearsalError(409, '삭제된 버티포트입니다.')
        return copy.deepcopy(self.add(member, facility_id, 'facility_report', '시설 보고', note))

    def decide(self, token, request_id, version, action, note):
        member = self.member(token)
        if member['role'] != 'psu':
            raise RehearsalError(403, 'PSU 역할에서만 응답할 수 있습니다.')
        request = next((r for r in self.requests if r['id'] == request_id), None)
        if not request:
            raise RehearsalError(404, '요청을 찾을 수 없습니다.')
        if request['facility_id'] not in self.facilities():
            raise RehearsalError(409, '삭제된 버티포트의 요청입니다.')
        if request['version'] != version:
            raise RehearsalError(409, '다른 운영자가 먼저 변경했습니다. 최신 요청을 확인해 주세요.')
        allowed = ('acknowledged',) if request['kind'] == 'facility_report' else ('hold', 'proceed', 'resequence', 'rejected')
        if action not in allowed:
            raise RehearsalError(422, '요청 종류에 맞지 않는 응답입니다.')
        if request['state'] in ('proceed', 'rejected', 'acknowledged'):
            raise RehearsalError(409, '처리된 요청입니다. 중복 응답하지 않습니다.')
        previous = dict(request)
        request.update(state=action, response=note, responder=member['name'],
                       updated_at=self.clock(), version=version+1)
        self.revision += 1
        self.history.insert(0, dict(request_id=request_id, callsign=request['callsign'], action=action,
                                   author=member['name'], note=note, at=self.clock()))
        del self.history[100:]
        self.audit('rehearsal_decision', scope='shared_rehearsal', room_id=self.room_id,
                   correlation_id=self.room_id + ':' + request_id, actor=self.public_member(member),
                   before=previous, after=request, outcome=action, vehicle_command=False)
        return copy.deepcopy(request)
