// Render-only replay of a plan-owned schedule. No crowd simulation or polling.
export const BOARDING_VISIBLE_M = 650;

// Where each person on one schedule is, this far into it. The schedule owns the
// path, the spacing and the walking speed; this only reads them, so a single
// flight's replay and a whole day's decks place people the same way.
export function walkersAt(schedule, elapsed_s) {
  const b = schedule;
  if (!b || !Array.isArray(b.release_s) || !Number.isFinite(elapsed_s)) return null;
  const passengers = b.release_s.map((release, index) => {
    const elapsed = elapsed_s - release;
    const boarded = elapsed >= b.walk_s + b.enter_s;
    const visible = elapsed >= 0 && !boarded;
    const distance = Math.min(b.distances_m.at(-1), Math.max(0, elapsed * b.walk_mps));
    let segment = 1;
    while (segment < b.distances_m.length - 1 && b.distances_m[segment] < distance) segment++;
    const a = b.path[segment - 1], z = b.path[segment];
    const span = b.distances_m[segment] - b.distances_m[segment - 1];
    const f = span > 0 ? (distance - b.distances_m[segment - 1]) / span : 0;
    const heading = Math.atan2((z[0]-a[0])*Math.cos(a[1]*Math.PI/180), z[1]-a[1]) * 180/Math.PI;
    return {index, elapsed, visible, boarded, walking:elapsed < b.walk_s,
      longitude:a[0]+(z[0]-a[0])*f, latitude:a[1]+(z[1]-a[1])*f, heading,
      height_offset_m:b.path_height_offsets_m?b.path_height_offsets_m[segment-1]+(b.path_height_offsets_m[segment]-b.path_height_offsets_m[segment-1])*f:0,
      altitude_m:b.path_altitudes_m?b.path_altitudes_m[segment-1]+(b.path_altitudes_m[segment]-b.path_altitudes_m[segment-1])*f:undefined};
  });
  return {passengers, boarded:passengers.filter(p=>p.boarded).length, total:b.count,
    schedule:b, active:elapsed_s>=0 && elapsed_s < b.duration_s};
}

export function boardingAt(plan, seconds) {
  if (!Number.isFinite(seconds)) return null;
  const charge=plan?.legs?.find(leg=>leg.stage==='charge');
  const arriving=plan?.alighting && charge && seconds>=charge.start_s;
  const b=arriving ? plan.alighting : plan?.boarding;
  if (!b) return null;
  const state=walkersAt(b, seconds-(arriving ? charge.start_s : 0));
  return state && {...state, phase:arriving?'alighting':'boarding'};
}

export class PassengerBoardingLayer {
  constructor(C, scene, plan, assets, warning=()=>{}) {
    this.C=C; this.scene=scene; this.plan=plan; this.assets=assets; this.warning=warning;
    this.models=scene.primitives.add(new C.PrimitiveCollection());
    this.slots=[]; this.disposed=false; this.loading=false; this.failed=false;
    this.schedule=null;
    this.time=0; this.height=plan.legs[0].path[0][2]+.03;
    const p=(plan.boarding ?? plan.alighting).path[0];
    this.anchor=C.Cartesian3.fromDegrees(p[0],p[1],this.height);
    this.scratch=new C.Cartesian3();
  }
  matrix(person, result) {
    const C=this.C;
    C.Cartesian3.fromDegrees(person.longitude,person.latitude,Number.isFinite(person.altitude_m)?person.altitude_m+.03:this.height+(person.height_offset_m??0),undefined,this.scratch);
    // Kenney character faces glTF +Z. ForwardAxis.Z maps it to the heading frame.
    return C.Transforms.headingPitchRollToFixedFrame(this.scratch,
      new C.HeadingPitchRoll(C.Math.toRadians(person.heading-90),0,0),undefined,undefined,result);
  }
  async load() {
    if(this.loading || this.slots.length || this.failed || this.disposed)return;
    const b=this.schedule, asset=this.assets(b.asset_id);
    if(!asset?.uri)return; // Catalogue may still be loading; try on a later frame.
    this.loading=true;
    try {
      // One tiny mesh/texture URI for all passengers; Cesium shares its resource cache.
      for(let i=0;i<b.count;i++) {
        const model=await this.C.Model.fromGltfAsync({url:asset.uri,show:false,
          modelMatrix:this.C.Transforms.eastNorthUpToFixedFrame(this.anchor),
          scale:b.height_m/2.7,minimumPixelSize:0,maximumScale:b.height_m/2.7,
          forwardAxis:this.C.Axis.Z,upAxis:this.C.Axis.Y,
          id:{aerodtPassenger:{vehicle:this.plan.vehicle.id,index:i+1}}});
        if(this.disposed){model.destroy();return;}
        const slot={model:this.models.add(model),index:i,elapsed:0,animated:false,matrix:new this.C.Matrix4()};
        this.slots.push(slot);
        this.scene.requestRender?.();
      }
    } catch {this.failed=true;this.warning('탑승객 모델을 불러오지 못했습니다. 탑승 시간표는 유지합니다.');}
    finally {this.loading=false;}
  }
  update(seconds, shown=true) {
    if(this.disposed)return;
    this.time=seconds;
    const state=boardingAt(this.plan,seconds);
    if(state && state.schedule!==this.schedule) {
      this.schedule=state.schedule;
      const leg=state.phase==='alighting' ? this.plan.legs.find(l=>l.stage==='charge') : this.plan.legs[0];
      this.height=leg.path[0][2]+.03;
      const p=this.schedule.path[0];
      this.C.Cartesian3.fromDegrees(p[0],p[1],this.height,undefined,this.anchor);
    }
    const near=this.C.Cartesian3.distance(this.scene.camera.positionWC,this.anchor)<BOARDING_VISIBLE_M;
    const active=shown && state?.active && near;
    if(active)void this.load();
    for(const slot of this.slots) {
      const person=state?.passengers[slot.index];
      slot.model.show=Boolean(active && person?.visible);
      if(!slot.model.show)continue;
      slot.elapsed=Math.min(person.elapsed,this.schedule.walk_s);
      slot.model.modelMatrix=this.matrix(person,slot.matrix);
      if(slot.model.ready && !slot.animated) {
        slot.animated=true;
        try {
          slot.model.activeAnimations.animateWhilePaused=true;
          slot.model.activeAnimations.add({name:'walk',loop:this.C.ModelAnimationLoop.REPEAT,
            animationTime:duration=>Math.max(0,slot.elapsed)/duration});
        } catch {this.warning('탑승객 걷기 애니메이션이 없어 이동만 표시합니다.');}
      }
    }
    return state;
  }
  destroy() {
    this.disposed=true;
    this.scene.primitives.remove(this.models);
    this.slots=[];
  }
}
