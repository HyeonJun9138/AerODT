"""Immutable prepared flight documents. No simulation or resource allocation."""
import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path


def _digest(plan):
    payload = json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


class FlightPlans:
    def __init__(self, directory):
        self.directory = Path(directory)

    def create(self, plan):
        plan_id = 'plan-' + uuid.uuid4().hex
        document = {'schema_version': 1, 'plan_id': plan_id,
                    'created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                    'content_sha256': _digest(plan), 'plan': plan}
        self.directory.mkdir(parents=True, exist_ok=True)
        pending = self.directory / (plan_id + '.pending')
        try:
            with pending.open('x', encoding='utf-8') as file:
                json.dump(document, file, ensure_ascii=False, allow_nan=False)
                file.flush()
                os.fsync(file.fileno())
            pending.replace(self.directory / (plan_id + '.json'))
        finally:
            pending.unlink(missing_ok=True)
        # The caller cannot mutate an in-memory cache of the stored plan.
        return self.get(plan_id)

    def get(self, plan_id):
        if not isinstance(plan_id, str) or not re.fullmatch(r'plan-[0-9a-f]{32}', plan_id):
            return None
        path = self.directory / (plan_id + '.json')
        try:
            if path.resolve().parent != self.directory.resolve():
                return None
            document = json.loads(path.read_text(encoding='utf-8'))
            if (document['schema_version'] != 1 or document['plan_id'] != plan_id or
                    document['content_sha256'] != _digest(document['plan'])):
                return None
            return document
        except (OSError, ValueError, KeyError, TypeError):
            return None

