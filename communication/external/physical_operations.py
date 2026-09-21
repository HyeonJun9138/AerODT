"""Bounded read-only Physical operational observation protocol."""
import json
import math
import re


def validate_operations(body):
    if not isinstance(body,dict) or body.get('schema_version')!=1:raise ValueError('Invalid operations schema')
    if body.get('available') is False:return body
    if body.get('available') is not True:raise ValueError('Invalid operations availability')
    for key in ('run_id','process_id'):
        if not isinstance(body.get(key),str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',body[key]):raise ValueError('Invalid operations ID')
    for key in ('source_started_at','generated_at'):
        if not isinstance(body.get(key),(float,int)) or not math.isfinite(body[key]) or body[key]<=0:raise ValueError('Invalid operations time')
    for key in ('sequence','after','next','event_count'):
        if type(body.get(key)) is not int or not 0<=body[key]<=2_000_000:raise ValueError('Invalid operations sequence')
    if not 0<=body['after']<=body['next']<=body['event_count']:raise ValueError('Invalid event range')
    if type(body.get('has_more')) is not bool or body['has_more']!=(body['next']<body['event_count']):raise ValueError('Invalid event completeness')
    events=body.get('events')
    if not isinstance(events,list) or len(events)>1000 or len(events)!=body['next']-body['after']:raise ValueError('Invalid event page')
    last=0
    for e in events:
        if not isinstance(e,dict) or type(e.get('event_sequence')) is not int or e['event_sequence']<=last:raise ValueError('Invalid event order')
        last=e['event_sequence']
    if body['has_more'] and not events:raise ValueError('Empty advancing page')
    frame=body.get('frame');analysis=body.get('analysis')
    if not isinstance(frame,dict) or not isinstance(frame.get('status'),dict) or not isinstance(analysis,dict):raise ValueError('Invalid operations frame')
    if analysis.get('meta',{}).get('scenario_id')!=body['run_id'] or frame['status'].get('scenario_id')!=body['run_id']:raise ValueError('Operations run mismatch')
    if not isinstance(frame.get('decks'),dict) or len(frame['decks'])>100 or not isinstance(frame.get('aircraft'),dict) or len(frame['aircraft'])>128:raise ValueError('Operations frame exceeds bounds')
    config=body.get('configuration')
    if config is not None:
        if not isinstance(config,dict) or not isinstance(config.get('environment'),dict) or not isinstance(config.get('analysis_base'),dict):raise ValueError('Invalid operations configuration')
        plans=config['analysis_base'].get('plans');ports=config['environment'].get('vertiports')
        if not isinstance(plans,list) or len(plans)>20000 or not all(isinstance(p,dict) for p in plans):raise ValueError('Invalid operation plans')
        if not isinstance(ports,list) or len(ports)>100:raise ValueError('Invalid operational facilities')
    return body


async def fetch_operations(client,url,run_id='',after=0):
    async with client.stream('GET',url.rstrip('/')+'/api/v1/operations',params={'run_id':run_id,'after':after},timeout=5) as response:
        response.raise_for_status();parts=[];size=0
        async for part in response.aiter_bytes():
            size+=len(part)
            if size>16*1024*1024:raise ValueError('Operations response exceeds 16 MB')
            parts.append(part)
    return validate_operations(json.loads(b''.join(parts)))

