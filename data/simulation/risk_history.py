"""Bounded immutable past observations. Missing detections remain missing."""
from collections import OrderedDict
from dataclasses import dataclass, field
import math
import threading
import time

STEP=.5
STEPS=20
ASSUMED_SIGMA_M=10.


def finite(value):
    return isinstance(value,(int,float)) and math.isfinite(value)


@dataclass(frozen=True)
class RiskObservation:
    time: float
    position_ecef_m: tuple
    sigma_m: float
    covariance_basis: str
    basis: str
    age_steps: float


@dataclass
class TrackHistory:
    context: tuple
    first_time: float
    last_token: object=None
    samples: OrderedDict=field(default_factory=OrderedDict)


class RiskHistory:
    def __init__(self, *, max_entities=512,clock=None):
        self.max_entities=max_entities
        self.entries=OrderedDict()
        self.epoch=None
        self.generation=0
        self.last_time=None
        self._lock=threading.RLock()
        self._clock=clock or time.monotonic
        self._leases=OrderedDict()

    def lease(self,entity_ids,*,epoch):
        """Protect a bounded recent selection for 15 real seconds, not forever."""
        with self._lock:
            if epoch!=self.epoch:return
            now=self._clock();self._expire_leases(now)
            limit=min(128,self.max_entities)
            for key in list(dict.fromkeys(entity_ids))[:limit]:
                self._leases[key]=now+15.;self._leases.move_to_end(key)
            while len(self._leases)>limit:self._leases.popitem(last=False)

    def _expire_leases(self,now):
        for key,expiry in list(self._leases.items()):
            if expiry<=now:del self._leases[key]

    def observe(self,snapshot):
        moment=snapshot.state_time
        if not finite(moment):return
        with self._lock:
            if snapshot.epoch!=self.epoch or (self.last_time is not None and moment<self.last_time):
                self.entries.clear();self.epoch=snapshot.epoch;self.generation+=1
                self._leases.clear()
            self._expire_leases(self._clock())
            self.last_time=moment
            end=math.floor(moment/STEP+1e-7)
            for entity in snapshot.entities:
                if entity.kind not in ('uam','aircraft','drone','bird','unknown'):continue
                pose=entity.display_observation
                context=(entity.continuity_id,entity.source,entity.provenance,pose.context if pose else None)
                track=self.entries.get(entity.entity_id)
                if track is None or track.context!=context or entity.discontinuity:
                    track=TrackHistory(context,moment);self.entries[entity.entity_id]=track
                if entity.quality in ('stale','frozen','unavailable','invalid'):
                    continue
                if entity.valid_until is not None and entity.valid_until<moment:continue
                # DisplayObservation is the accepted navigation posterior at the
                # observed instant, not the current extrapolated entity pose.
                token=pose.observation_time if pose else entity.observation_time
                position=pose.position_ecef_m if pose else entity.position_ecef_m
                simulated=entity.derivation=='simulated' or entity.source in ('scenario','simulation','native')
                if simulated:
                    token=entity.state_time;basis='experimental_simulation_state'
                else:
                    if pose is None and entity.derivation!='observed':continue
                    basis='accepted_navigation_observation' if pose else 'observed_track_state'
                if token is None or not finite(token) or token==track.last_token:continue
                if track.last_token is not None and token<track.last_token:
                    track=TrackHistory(context,moment);self.entries[entity.entity_id]=track
                if len(position)!=3 or not all(finite(v) for v in position):continue
                # Reject old navigation data; the model sees a missing slot,
                # never a fabricated repeated detection from current estimates.
                if not simulated and entity.estimation is not None and entity.estimation.observation_age_s>1.:
                    continue
                if not simulated and pose is None and abs(entity.state_time-token)>1.:continue
                sigma=ASSUMED_SIGMA_M;cov_basis='assumed_isotropic_10m_sigma'
                if entity.estimation is not None and finite(entity.estimation.horizontal_sigma_m):
                    sigma=max(.01,entity.estimation.horizontal_sigma_m)
                    cov_basis='posterior_horizontal_sigma_isotropic_approximation'
                track.last_token=token
                row=RiskObservation(moment,tuple(position),sigma,cov_basis,basis,
                                    min(200.,(moment-track.first_time)/STEP+1))
                # Keep only first/latest endpoints in each slot. An older
                # request can use the first endpoint, never the later future.
                old=track.samples.get(end)
                track.samples[end]=(old[0],row) if old and old[0].time!=moment else (row,)
                self.entries.move_to_end(entity.entity_id)
            for key,track in list(self.entries.items()):
                for slot in list(track.samples):
                    if slot<end-STEPS+1:del track.samples[slot]
                if not track.samples:del self.entries[key]
            while len(self.entries)>self.max_entities:
                victim=next((key for key in self.entries if key not in self._leases),next(iter(self.entries)))
                del self.entries[victim]

    def observe_perceived(self,entity_id,moment,position,sigma_m,*,epoch,context=(),basis='camera_detection_estimate'):
        """One camera sighting of a perceived object, as a row in its history.

        Not a snapshot: the twin's clock is not advanced or reset by a viewer's
        report, and a report for another epoch is ignored. The row carries the
        estimate's own error, which is large along the camera's line of sight,
        so the model weighs a sighting as what it is.
        """
        if not finite(moment) or len(position)!=3 or not all(finite(v) for v in position):return False
        with self._lock:
            if epoch!=self.epoch or self.last_time is None:return False
            # A sighting from the future of the twin's clock is a clock
            # disagreement, not an observation; one much older than the
            # window is already outside it.
            if moment>self.last_time+2. or moment<self.last_time-STEP*STEPS:return False
            track=self.entries.get(entity_id)
            if track is None or track.context!=context:
                track=TrackHistory(context,moment);self.entries[entity_id]=track
            if track.last_token is not None and moment<=track.last_token:return False
            track.last_token=moment
            row=RiskObservation(moment,tuple(float(v) for v in position),max(.01,float(sigma_m)),
                                'injected_assumed_10m_sigma' if basis=='injected_test_state' else 'camera_range_from_apparent_size',basis,
                                min(200.,(moment-track.first_time)/STEP+1))
            slot=math.floor(moment/STEP+1e-7);old=track.samples.get(slot)
            track.samples[slot]=(old[0],row) if old and old[0].time!=moment else (row,)
            end=math.floor(self.last_time/STEP+1e-7)
            for s in list(track.samples):
                if s<end-STEPS+1:del track.samples[s]
            self.entries.move_to_end(entity_id)
            while len(self.entries)>self.max_entities:
                victim=next((key for key in self.entries if key not in self._leases and key!=entity_id),next(iter(self.entries)))
                del self.entries[victim]
            return True

    def window(self,entity_id,end):
        with self._lock:
            index=math.floor(end/STEP+1e-7);track=self.entries.get(entity_id)
            return tuple(next((row for row in reversed(track.samples.get(i,())) if row.time<=end),None)
                         if track else None for i in range(index-STEPS+1,index+1))

    def windows(self,entity_ids,end,epoch):
        with self._lock:
            if self.epoch!=epoch:return {key:(None,)*STEPS for key in entity_ids}
            return {key:self.window(key,end) for key in entity_ids}
