"""Bounded past feature samples. No ownership of current simulation state."""
from collections import OrderedDict, deque
import math


class PredictionHistory:
    def __init__(self, *, max_entities=8, max_samples=240, retention_seconds=40, max_gap_seconds=2.5):
        self.entries=OrderedDict()
        self.max_entities=max_entities
        self.max_samples=max_samples
        self.retention_seconds=retention_seconds
        self.max_gap_seconds=max_gap_seconds

    def clear(self):
        self.entries.clear()

    def latest(self, entity_id, context):
        found=self.entries.get(entity_id)
        return found[1][-1] if found and found[0]==context and found[1] else None

    def append(self, entity_id, context, moment, values, *, target_key=None):
        values=tuple(values)
        if len(values)!=21 or not math.isfinite(moment) or not all(math.isfinite(v) for v in values):
            return False
        old=self.entries.get(entity_id)
        if old is None or old[0]!=context or (old[1] and moment<old[1][-1][0]):
            old=(context,deque(maxlen=self.max_samples));self.entries[entity_id]=old
        samples=old[1]
        if samples and moment==samples[-1][0]:return False
        # Keep the latest endpoint in each fixed 0.2 s bin. Even dense GETs
        # cannot displace a 28.8 s window; current state remains runtime-owned.
        if samples and math.floor(moment/.2)==math.floor(samples[-1][0]/.2):
            samples.pop()
        samples.append((float(moment),values,target_key));self.entries.move_to_end(entity_id)
        while len(samples)>2 and samples[1][0]<moment-self.retention_seconds:samples.popleft()
        while len(self.entries)>self.max_entities:self.entries.popitem(last=False)
        return True

    def window(self, entity_id, context, end, step, *, steps=25):
        found=self.entries.get(entity_id)
        samples=list(found[1]) if found and found[0]==context else []
        required=(steps-1)*step
        available=max(0,min(end,samples[-1][0])-samples[0][0]) if samples else 0
        result={'status':'warming_up','rows':None,'history_seconds':required,
                'available_history_seconds':available,'reason':f'입력 이력 준비 중 ({min(available,required):.1f}/{required:.1f}초)'}
        if not samples or samples[0][0]>end-required+1e-6 or samples[-1][0]<end-1e-6:return result
        rows=[];j=0
        for n in range(steps):
            at=end-required+n*step
            while j<len(samples)-2 and samples[j+1][0]<at-1e-7:j+=1
            a,b=samples[j],samples[min(j+1,len(samples)-1)]
            gap=b[0]-a[0]
            if gap>self.max_gap_seconds:
                result['reason']='입력 이력 간격이 너무 큽니다. 연속 표본을 다시 모으는 중입니다.';return result
            u=0 if gap==0 else min(1,max(0,(at-a[0])/gap))
            values=[]
            for index,(x,y) in enumerate(zip(a[1],b[1])):
                if index>=16 and a[2]!=b[2]:
                    # A changed active target is discrete, not a waypoint between two legs.
                    values.append(x if u<.5 else y)
                    continue
                delta=(y-x+180)%360-180 if index in (4,5,6) else y-x
                value=x+delta*u
                values.append((value+180)%360-180 if index in (4,5,6) else value)
            rows.append(tuple(values))
        return {**result,'status':'ready','rows':tuple(rows),'reason':''}
