// People getting on and off, across a whole scheduled day.
//
// The single-flight replay draws one aircraft's boarding from the plan it is
// replaying. A day has a hundred aircraft and eighteen decks, so this works the
// other way round: the server says who is walking right now, and the display
// spends a fixed budget of models on the walks the camera can actually see.
//
// Nothing here decides when anybody boards. The schedule is the plan's, the
// clock is the day's, and the only judgement made here is which walks are worth
// drawing — nearest first, and never more people than the budget allows.
import {walkersAt} from './passenger_boarding.js?v=20260917-cabin-passengers';

// How near a deck has to be before its people are worth drawing at all, and how
// many bodies may be on screen across every deck put together. A person is a
// small mesh, but a hundred of them on eighteen decks is a hundred draw calls
// for figures a few pixels tall.
export const PASSENGER_VISIBLE_M = 900;
export const PASSENGER_BUDGET = 28;
export const REFRESH_MS = 1500;
// Legacy responses without an absolute timestamp use bounded carry-forward.
// Timestamped responses use the same display clock as the aircraft instead.
// A legacy walk is carried forward at the speed the day is running,
// but never further than a refresh and a half is worth. If an answer is late,
// the people slow to a stop and pick up where the day actually is rather than
// running ahead of it and being snapped back - a walker who stops for a moment
// reads as a walker; one who jumps backwards reads as a broken screen.
const CARRY_LIMIT = REFRESH_MS * 1.5 / 1000;

export class ScenarioPassengerLayer {
  constructor(C, scene, {load, assets, warning = () => {}, deckTop = () => null,
      budget = PASSENGER_BUDGET, visible_m = PASSENGER_VISIBLE_M, displayAnchor = () => null,
      now = () => globalThis.performance?.now?.() ?? Date.now()} = {}) {
    Object.assign(this, {C, scene, load, assets, warning, deckTop, budget, visible_m, now, displayAnchor});
    this.models = scene.primitives.add(new C.PrimitiveCollection());
    this.cables = C.PolylineCollection ? scene.primitives.add(new C.PolylineCollection()) : null;
    this.cableSlots=[];
    this.pending=false;this.generation=0;this.walkProgress=new Map();
    this.slots = [];            // the pool of bodies, reused across decks
    this.cabins = [];
    this.walks = [];            // what the server last said is happening
    this.crew = [];             // and who is out on the decks for the aircraft
    this.fetchedAt = -Infinity;
    // The day's clock against the wall clock. The server is asked once every
    // refresh, which at four times speed is six seconds of walking per answer;
    // without carrying the time forward in between, everybody stands still and
    // then teleports. The rate is measured from consecutive answers rather than
    // passed in, so a pause, a seek and a change of speed all take care of
    // themselves - a paused day measures zero and nobody moves.
    this.anchor = null;         // {wall, day} of the last answer
    this.rate = 0;              // day-seconds per wall-second
    this.loading = false; this.failed = false; this.disposed = false; this.shown = false;
    this.scratch = new C.Cartesian3();
    this.drawn = 0;
  }

  // The pool is built once and then reused: a body is a body, whichever deck it
  // is standing on, so nothing is loaded again when the busy deck changes.
  async fill(asset) {
    if (this.loading || this.failed || this.disposed || this.slots.length >= this.budget) return;
    if (!asset?.uri) return;    // the catalogue may still be loading
    this.loading = true;
    try {
      for (let index = this.slots.length; index < this.budget; index += 1) {
        // Not everybody is the same height: each body in the pool is a
        // little taller or shorter than the 1.75 m the schedule names
        // (1.62-1.82 m), so a queue reads as people rather than as copies.
        const scale = (1.75 + ((index * 7) % 11 - 5) * 0.02) / 2.7;
        const model = await this.C.Model.fromGltfAsync({url: asset.uri, show: false,
          modelMatrix: this.C.Matrix4.IDENTITY.clone(),
          scale, minimumPixelSize: 0, maximumScale: scale,
          forwardAxis: this.C.Axis.Z, upAxis: this.C.Axis.Y,
          id: {aerodtScenarioPassenger: {index}}});
        if (this.disposed) {model.destroy(); return;}
        this.slots.push({model: this.models.add(model), matrix: new this.C.Matrix4(),
          animated: false, elapsed: 0});
      }
      this.scene.requestRender?.();
    } catch {
      this.failed = true;
      this.warning('탑승객 모델을 불러오지 못했습니다. 탑승·하기 시간표는 그대로 진행합니다.');
    } finally {this.loading = false;}
  }

  matrix(person, height, result) {
    const C = this.C;
    C.Cartesian3.fromDegrees(person.longitude, person.latitude, height, undefined, this.scratch);
    // Kenney character faces glTF +Z; ForwardAxis.Z maps it to the heading frame.
    return C.Transforms.headingPitchRollToFixedFrame(this.scratch,
      new C.HeadingPitchRoll(C.Math.toRadians(person.heading - 90), 0, 0), undefined, undefined, result);
  }

  setShown(shown) {
    this.shown = Boolean(shown);
    if (!this.shown) {
      this.generation++;this.walks=[];this.crew=[];this.cabins=[];this.walkProgress.clear();this.anchor=null;this.rate=0;
      this.fetchedAt=-Infinity;this.hideAll();
    }
  }

  hideAll() {
    for (const slot of this.slots) slot.model.show = false;
    for(const cable of this.cableSlots)cable.show=false;
    this.drawn = 0;
  }

  // Every walk the server reported, nearest deck first, with the people who are
  // actually out of the shelter. Answers the flat list the budget is spent on.
  // How far the day has moved on since the server last answered.
  carried() {
    if (!this.anchor || !(this.rate > 0)) return 0;
    const seconds = Math.max(0, (this.now() - this.anchor.wall) / 1000);
    return Math.min(seconds, CARRY_LIMIT) * this.rate;
  }

  // How far the day has moved on since the answer, on the aircraft's own
  // display clock when there is one and by measured carry-forward otherwise.
  // Null when the answer belongs to another display epoch and must not move.
  carriedSeconds() {
    const shared=this.displayAnchor?.();
    if(shared && this.walkEpoch!==undefined && shared.epoch!==this.walkEpoch)return null;
    return Number.isFinite(shared?.time)&&Number.isFinite(this.stateTime) ? shared.time-this.stateTime : this.carried();
  }

  people(camera) {
    const C = this.C, out = [];
    const carried=this.carriedSeconds();
    if(carried===null)return out;
    for (const walk of this.walks) {
      const schedule = walk?.walk;
      if (!schedule || !Array.isArray(schedule.path) || schedule.path.length < 2) continue;
      const start = schedule.path[0];
      const placed=this.deckTop(walk.vertiport);
      const height = (Number.isFinite(placed)?placed:Number(walk.deck_m ?? schedule.deck_m ?? 0)) + 0.03;
      const anchor = C.Cartesian3.fromDegrees(start[0], start[1], height);
      const distance = C.Cartesian3.distance(camera, anchor);
      if (!(distance < this.visible_m)) continue;
      const key=[walk.aircraft_id,walk.flight_id,walk.phase].join('|');
      // Rounded API elapsed values must not push an already shown person back.
      const elapsed=Math.max(this.walkProgress.get(key) ?? -Infinity,Number(walk.elapsed_s)+carried);
      this.walkProgress.set(key,elapsed);
      const state = walkersAt(schedule, elapsed);
      if (!state) continue;
      for (const person of state.passengers) {
        if (person.visible) out.push({person, distance, height:height+(person.height_offset_m??0)});
      }
    }
    for(const crew of this.crew){
      const path=crew.path;
      const f=Math.max(0,Math.min(1,(Number(crew.elapsed_s)+carried)/(crew.walk_s||1)));
      const a=path?.[0],z=path?.at(-1);
      const longitude=a?a[0]+(z[0]-a[0])*f:crew.longitude;
      const latitude=a?a[1]+(z[1]-a[1])*f:crew.latitude;
      if(!Number.isFinite(longitude)||!Number.isFinite(latitude)||crew.action==='wait')continue;
      const height=(this.deckTop(crew.vertiport)??crew.deck_m??0)+.03;
      const distance=C.Cartesian3.distance(camera,C.Cartesian3.fromDegrees(longitude,latitude,height));
      if(distance>=this.visible_m)continue;
      out.push({distance,height,crew,progress:f,person:{longitude,latitude,elapsed:path?Math.min(crew.walk_s,Math.max(0,Number(crew.elapsed_s)+carried)):0,
        heading:path?Math.atan2((z[0]-a[0])*Math.cos(latitude*Math.PI/180),z[1]-a[1])*180/Math.PI:crew.heading}});
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  // Called from the render loop. Fetches on its own slow schedule and repaints
  // every frame it is asked to, because people walk between fetches.
  update() {
    if (this.disposed || !this.shown) return false;
    if (this.now() - this.fetchedAt >= REFRESH_MS) {
      this.fetchedAt = this.now();
      void this.refresh();
    }
    if (!this.walks.length && !this.crew.length) {
      if (this.drawn) {this.hideAll(); return true;}
      return false;
    }
    // The schedule names the body to draw, so the day and the single-flight
    // replay use the same one without this layer knowing which it is.
    const asset = this.assets?.(this.walks[0]?.walk?.asset_id ?? this.crew[0]?.asset_id);
    if (asset) void this.fill(asset);
    const walking = this.people(this.scene.camera.positionWC);
    let cables=0;
    if(this.cables)for(const item of walking.slice(0,this.budget)){
      if(item.crew?.role!=='charger'||item.crew.action!=='walk'||item.progress>=1)continue;
      if(cables>=8)break;
      const C=this.C,start=item.crew.path[0],end=item.person;
      const line=this.cableSlots[cables]??(this.cableSlots[cables]=this.cables.add({width:3,material:C.Material.fromType('Color',{color:C.Color.fromCssColorString('#26343b')})}));
      line.show=true;line.positions=[C.Cartesian3.fromDegrees(start[0],start[1],item.height+1.1),C.Cartesian3.fromDegrees((start[0]+end.longitude)/2,(start[1]+end.latitude)/2,item.height+.08),C.Cartesian3.fromDegrees(end.longitude,end.latitude,item.height+.85)];cables++;
    }
    for(let i=cables;i<this.cableSlots.length;i++)this.cableSlots[i].show=false;
    let used = 0;
    for (const slot of this.slots) {
      const item = walking[used];
      if (!item) {slot.model.show = false; continue;}
      used += 1;
      slot.model.show = true;
      slot.model.modelMatrix = this.matrix(item.person, item.height, slot.matrix);
      slot.elapsed = Math.max(0, item.person.elapsed);
      if (slot.model.ready && !slot.animated) {
        slot.animated = true;
        try {
          slot.model.activeAnimations.animateWhilePaused = true;
          slot.model.activeAnimations.add({name: 'walk', loop: this.C.ModelAnimationLoop.REPEAT,
            animationTime: duration => Math.max(0, slot.elapsed) / duration});
        } catch {/* a model without a walk still moves; it just does not step */}
      }
    }
    const changed = used !== this.drawn;
    this.drawn = used;
    return changed || used > 0;
  }

  async refresh() {
    if(this.pending || this.disposed)return;
    this.pending=true;
    const generation=this.generation,epoch=this.displayAnchor?.()?.epoch;
    try {
      const answer = await this.load();
      if (this.disposed || generation!==this.generation || epoch!==this.displayAnchor?.()?.epoch) return;
      if(epoch!==undefined && this.walkEpoch===epoch && this.scenarioId===answer?.scenario_id
          && Number.isFinite(this.stateTime) && Number.isFinite(answer?.state_time) && answer.state_time<this.stateTime)return;
      if(this.walkEpoch!==epoch || this.scenarioId!==answer?.scenario_id || Number(answer?.time_s)<this.anchor?.day)this.walkProgress.clear();
      this.walkEpoch=epoch;this.scenarioId=answer?.scenario_id;
      this.stateTime=Number.isFinite(answer?.state_time)?answer.state_time:null;
      this.walks = Array.isArray(answer?.aircraft) ? answer.aircraft : [];
      this.cabins = Array.isArray(answer?.cabins)?answer.cabins:[];
      this.crew = Array.isArray(answer?.crew) ? answer.crew : [];
      const keys=new Set(this.walks.map(w=>[w.aircraft_id,w.flight_id,w.phase].join('|')));
      for(const key of this.walkProgress.keys())if(!keys.has(key))this.walkProgress.delete(key);
      this.measure(Number(answer?.time_s), this.now());
    } catch {if(generation===this.generation){this.walks = []; this.crew = []; this.cabins=[]; this.anchor = null; this.rate = 0;}}
    finally {this.pending=false;}
  }

  // Two answers say how fast the day is running. A backwards step or a leap is
  // somebody moving the clock rather than the day passing, so it sets no rate:
  // the walkers hold still for one refresh and carry on from wherever the day
  // turns out to be.
  measure(day, wall) {
    if (!Number.isFinite(day)) {this.anchor = null; this.rate = 0; return;}
    if (this.anchor) {
      const wallGap = (wall - this.anchor.wall) / 1000;
      const dayGap = day - this.anchor.day;
      this.rate = wallGap > 0.05 && dayGap >= 0 && dayGap <= wallGap * 64 ? dayGap / wallGap : 0;
    }
    this.anchor = {wall, day};
  }

  destroy() {
    this.disposed = true;
    this.scene.primitives.remove(this.models);
    if(this.cables)this.scene.primitives.remove(this.cables);
    this.slots = []; this.walks = [];
  }
}
