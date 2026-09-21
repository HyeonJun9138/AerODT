// World-space annotations obey depth: aircraft and opaque geometry occlude them.
// Draws one planned flight and the aircraft flying it: the whole route as a
// line coloured by stage, and the aircraft itself — the same quad tiltrotor
// model the simulation flies — turned to its heading and pitched along its
// path, with its name and a drop line to the ground beneath it.
//
// The plan is drawn once when it is shown; playing it only writes a position
// and a matrix, so a frame costs nothing and scrubbing backwards is as smooth
// as playing. Nothing here decides where the aircraft is — the panel samples
// the plan and hands over a position.
//
// The model is a picked primitive like the ones in the entity scene, so a
// click on the aircraft answers with the flight it belongs to. Until the model
// has loaded — or if it fails — the marker point carries it, so the flight is
// never invisible.
import {showCabin,showDoors,cabinAt} from './cabin_passengers.js?v=20260917-cabin-passengers';
import {ManualTurnaround} from './manual_turnaround.js?v=20260921-ground2';
import {loadVisualModel,visualModelScale} from './visual_asset_loader.js';
import {RotorSpin, rateOf, tiltOf, flightSpinOf} from './rotor_spin.js';
import {ControlSurfacePose} from './control_surface_pose.js';
import {PassengerBoardingLayer, boardingAt} from './passenger_boarding.js?v=20260917-cabin-passengers';
import {composeAircraftLabel,uamPhaseName} from './entity_labels.js';
export const STAGE_COLORS = {
  gate_out: '#7fe0a3', takeoff: '#6edc96', climb: '#ffb457', cruise: '#7fe9f5',
  descent: '#a5c8ff', landing: '#78beff', gate_in: '#7fe0a3', charge: '#ffd166',
};
export const PATH_WIDTH = 3;
export const VEHICLE_PIXELS = 15;
// A glTF in this library is loaded forward-axis X, but a heading frame points
// its +Y along the heading; the model is turned back by this quarter to fly
// the path it is on. displayHeading does the same for the live entity scene.
export const MODEL_HEADING_OFFSET_DEG = 90;
// A planned flight is local infrastructure like the route it follows: past
// this camera distance it goes, with the rest of the UAM network.
export const VISIBLE_METRES = 260000;
export const LABEL_FAR_METRES = VISIBLE_METRES;
// Screen-space typography, like the live aircraft/satellite labels. Distance
// controls visibility/fade, never the legibility of an individual character.
export function flightLabelScale() {return 1;}
// Project a conservative camera-aligned box around the public model bounds.
// CSS pixels (not drawing-buffer pixels) keep placement stable at every DPR.
export function flightLabelOffset(C, scene, model, position, result = new C.Cartesian2(), scratch = {}, extent = null, scale = 1, lines = 1) {
  result.x=0; result.y=-16*scale;
  if (!model?.ready || !model.show || !position || !C.SceneTransforms?.worldToWindowCoordinates) return result;
  const sphere=model.boundingSphere, camera=scene.camera;
  if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius<=0 || !camera?.upWC) return result;
  const project=C.SceneTransforms.worldToWindowCoordinates;
  const origin=project(scene,position,scratch.origin ??= new C.Cartesian2());
  const centre=project(scene,sphere.center,scratch.centre ??= new C.Cartesian2());
  if (!origin || !centre) return result;
  let top=Infinity;
  const p=scratch.point ??= new C.Cartesian3(), out=scratch.out ??= new C.Cartesian2();
  const local=scratch.local ??= new C.Cartesian3(), rotated=scratch.rotated ??= new C.Cartesian3();
  const {rightWC:right,upWC:up,directionWC:forward}=camera, r=sphere.radius;
  for (const x of [-1,1]) for (const y of [-1,1]) for (const z of [-1,1]) {
    if (extent && C.Matrix4?.multiplyByPointAsVector) {
      local.x=x*extent.length/2;local.y=y*extent.width/2;local.z=z*extent.height/2;
      C.Matrix4.multiplyByPointAsVector(model.modelMatrix,local,rotated);
      for (const axis of ['x','y','z']) p[axis]=sphere.center[axis]+rotated[axis];
    } else for (const axis of ['x','y','z']) p[axis]=sphere.center[axis]+r*(x*right[axis]+y*up[axis]+z*forward[axis]);
    const screen=project(scene,p,out);
    if (screen && Number.isFinite(screen.y)) top=Math.min(top,screen.y);
  }
  if (!Number.isFinite(top)) return result;
  result.x=centre.x-origin.x;
  result.y=Math.max((30+Math.max(0,lines-1)*18)*scale,top-12*scale)-origin.y;
  return result;
}

export class FlightLayer {
  constructor(C, viewer, {assets = () => null, onWarning = () => {},
    clock = () => (globalThis.performance?.now?.() ?? Date.now())} = {}) {
    this.C = C; this.entities = viewer.entities; this.scene = viewer.scene;
    this.assets = assets; this.onWarning = onWarning;this.turnaround=new ManualTurnaround(C,viewer,{assets,warning:onWarning});
    this.plan = null; this.owned = []; this.vehicle = null; this.visible = true;
    this.model = null; this.modelLoading = false; this.modelFailed = false;
    this.models = viewer.scene.primitives.add(new C.PrimitiveCollection());
    this.sample = null;
    // The propellers, once a model that has them is loaded, and the real
    // instant the last frame was drawn — the blades turn in real seconds, so
    // playing at sixteen times speed does not spin them sixteen times faster.
    this.rotors = null; this.rotorSpec = null; this.rotorsChecked = false; this.spunAt = 0;
    this.clock = clock;
    this.labelOffset=new C.Cartesian2(0,-16); this.labelScratch={};
    // Camera changes must reposition the name even when playback is paused.
    this.removeLabelFrame=this.scene.preRender?.addEventListener(()=>{
      // Initial model readiness is independent of playback. Apply the pose
      // once even while paused; do not advance blade phase in this callback.
      if (this.attachRotors()) this.scene.requestRender?.();
      this.updateLabelLayout();
      this.updateControlSurfaces();
      this.passengers?.update(this.sample?.time_s,!this.sample?.manual&&this.visible&&this.display?.passengers!==false);
      this.turnaround?.update(this.sample,this.model,this.assets(this.plan?.aircraft?.asset_id),this.plan,this.visible&&this.display?.passengers!==false);
      this.updateCabin();
    });
  }
  color(css, alpha) {return this.C.Color.fromCssColorString(css).withAlpha(alpha);}
  within(far = VISIBLE_METRES) {return new this.C.DistanceDisplayCondition(0, far);}
  add(description) {
    const entity = this.entities.add(description);
    entity.show = this.visible;
    this.owned.push(entity);
    return entity;
  }
  clear() {
    this.turnaround?.clear();
    this.surfaces=null;this.surfaceSpec=null;
    this.passengers?.destroy(); this.passengers=null;
    for (const entity of this.owned) this.entities.remove(entity);
    this.owned = []; this.vehicle = null; this.sample = null;
    this.lastLabelX=undefined; this.lastLabelY=undefined;
    this.lastLabelScale=undefined; this.lastLabelShown=undefined;
    this.lastLabelText=undefined; this.labelHasText=undefined;
    this.labelLineCount=1;
    this.labelBoundsAbort?.abort(); this.labelBoundsAbort=null; this.labelExtent=null;
    if (this.model) {this.models.remove(this.model); this.model = null;}
    this.rotors = null; this.rotorSpec = null; this.rotorsChecked = false; this.spunAt = 0;
    this.modelFailed = false;
  }
  // The asset that draws this aircraft, from the catalogue the page loaded.
  asset() {
    const wanted = this.plan?.aircraft?.asset_id;
    const asset = wanted ? this.assets(wanted) : null;
    return asset?.flight_visual ? {...asset, ...asset.flight_visual, metadata_uri: null} : asset;
  }
  // Position and attitude as one matrix: the heading it is flying, the pitch
  // of the path it is on, and the size of a real air taxi.
  //
  // The quarter turn is the library's model convention, the same one
  // displayHeading applies to every aircraft in the entity scene: a frame
  // built from a heading puts its +Y along that heading, while a glTF loaded
  // forward-axis-X flies along +X. Without it the aircraft crabs ninety
  // degrees to the right of the path it is on.
  matrixFor(sample) {
    const C = this.C, at = sample.position;
    const position = C.Cartesian3.fromDegrees(at.longitude, at.latitude, at.altitude_m);
    const hpr = new C.HeadingPitchRoll(C.Math.toRadians((sample.heading_deg || 0) - MODEL_HEADING_OFFSET_DEG),
      C.Math.toRadians(sample.pitch_deg || 0), C.Math.toRadians(sample.roll_deg || 0));
    // This is only the pose. loadModel applies the catalog's metre scale to
    // the same grounded rig used by scheduled flights and the Physical twin.
    return C.Transforms.headingPitchRollToFixedFrame(position, hpr);
  }
  async loadModel() {
    const asset = this.asset();
    if (!asset?.uri || this.model || this.modelLoading || this.modelFailed || !this.sample) return;
    this.modelLoading = true;
    const loadingPlan = this.plan;
    try {
      const model = await loadVisualModel(this.C, asset, {aerodtFlight: {kind: 'vehicle', plan: this.plan?.vehicle?.id}},
        this.matrixFor(this.sample),undefined,
        visualModelScale(this.assets(this.plan?.aircraft?.asset_id),{flight:true}));
      if (!this.plan || this.plan !== loadingPlan) {model.destroy(); return;}
      model.show = this.visible&&this.display?.aircraft!==false;
      this.model = this.models.add(model);
      void this.loadLabelExtent(asset,model);
      // The propellers are found once the model is ready, not now: a model that
      // has only just been parsed has no runtime nodes to look up yet.
      this.rotorSpec = asset?.rotors?.nodes?.length ? asset.rotors : null;
      this.surfaceSpec=asset?.rotors?.control_surfaces;this.surfaces=null;
      this.rotors = null; this.rotorsChecked = false;
      // The point stays under it, small, so a distant flight is still visible.
      if (this.vehicle) this.vehicle.marker.point.pixelSize = VEHICLE_PIXELS - 8;
      model.errorEvent.addEventListener(() => {
        this.modelFailed = true;
        if (this.vehicle) this.vehicle.marker.point.pixelSize = VEHICLE_PIXELS;
        this.onWarning('비행체 3D 모델 오류. 위치 점으로 표시합니다.');
      });
    } catch {
      if (this.plan !== loadingPlan) return;
      this.modelFailed = true;
      this.onWarning('비행체 3D 모델을 불러오지 못했습니다. 위치 점으로 표시합니다.');
    } finally {this.modelLoading = false;}
  }
  // The plan to draw, or null to take it off the map. Returns how many legs
  // were drawn, so the caller can say so.
  show(plan) {
    this.clear();
    this.plan = plan ?? null;
    if (!this.plan) return 0;
    if((this.plan.boarding ?? this.plan.alighting)?.count>0 && (this.plan.boarding ?? this.plan.alighting).count<=8)
      this.passengers=new PassengerBoardingLayer(this.C,this.scene,this.plan,this.assets,this.onWarning);
    const C = this.C;
    let drawn = 0;
    for (const leg of this.plan.legs ?? []) {
      const points = (leg.path ?? []).filter(point => Array.isArray(point) && point.length >= 3);
      if (points.length < 2) continue;
      // A leg that stands still is a dot on a map, not a line; its height
      // change is worth a vertical stroke instead.
      const still = points.every(point => point[0] === points[0][0] && point[1] === points[0][1]);
      const css = STAGE_COLORS[leg.stage] ?? '#e6f7fb';
      this.add({polyline: {
        positions: points.map(([lon, lat, alt]) => C.Cartesian3.fromDegrees(lon, lat, alt)),
        width: still ? 2 : PATH_WIDTH, material: this.color(css, still ? .55 : .9),
        arcType: C.ArcType?.NONE, distanceDisplayCondition: this.within()},
        aerodtFlight: {kind: 'leg', stage: leg.stage}});
      drawn++;
    }
    // The aircraft: a point, its name, and a line down to the ground so its
    // height over the city reads at a glance.
    const start = this.plan.legs?.[0]?.path?.[0] ?? [0, 0, 0];
    const at = C.Cartesian3.fromDegrees(start[0], start[1], start[2]);
    this.vehicle = {
      marker: this.add({position: at, aerodtFlight: {kind: 'vehicle', plan: this.plan.vehicle?.id},
        point: {pixelSize: VEHICLE_PIXELS, color: this.color('#ffffff', 1),
          outlineColor: this.color('#06121a', .9), outlineWidth: 2,
          disableDepthTestDistance: 0, distanceDisplayCondition: this.within()},
        label: {text: this.plan.vehicle?.id ?? 'UAM', font: '600 12px sans-serif',
          fillColor: this.color('#ffffff', 1), outlineColor: this.color('#06121a', .9), outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: C.VerticalOrigin.BOTTOM,
          horizontalOrigin: C.HorizontalOrigin?.CENTER, showBackground: true,
          backgroundColor: this.color('#071923', .78), backgroundPadding: new C.Cartesian2(8,5),
          pixelOffset: new C.Cartesian2(0, -16), disableDepthTestDistance: 0,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, LABEL_FAR_METRES)}}),
      drop: this.add({polyline: {positions: [at, at], width: 1.5,
        material: C.PolylineDashMaterialProperty
          ? new C.PolylineDashMaterialProperty({color: this.color('#ffffff', .5), dashLength: 10})
          : this.color('#ffffff', .5),
        arcType: C.ArcType?.NONE, distanceDisplayCondition: this.within()}}),
    };
    this.applyDisplay();
    return drawn;
  }
  // Where the aircraft is now, from a sample the panel took. Only positions,
  // matrices and colours are written: nothing is rebuilt while a flight plays.
  updateCabin(){
    if(!this.model?.ready||!this.sample)return;
    const profile=this.assets(this.plan?.aircraft?.asset_id)?.cockpit;
    const ground=this.sample.ground_handling;
    const b=boardingAt(this.plan,this.sample.time_s);
    let seats=[],state;
    if(ground?.walk){
      state=cabinAt(null,{walk:ground.walk,phase:'alighting',elapsed_s:this.sample.time_s-ground.start_s-2});seats=state.seats;
    }else if(this.sample.manual){seats=Array.from({length:this.plan?.vehicle?.passengers??0},(_,i)=>i);}
    else if(b){
      const elapsed=b.passengers[0]?.elapsed+(b.schedule.release_s[0]??0);
      state=cabinAt(null,{walk:b.schedule,phase:b.phase,elapsed_s:elapsed});seats=state.seats;
    }
    showCabin(this.C,this.model,profile,seats);
    if(!ground&&state)showDoors(this.C,this.model,profile,state);
  }
  moveTo(sample) {
    if (!this.vehicle || !sample?.position) return false;
    const C = this.C;
    this.sample = sample;
    if (this.model) {
      this.model.modelMatrix = this.matrixFor(sample);
      this.spinRotors(sample);
    } else void this.loadModel();
    const {latitude, longitude, altitude_m: altitude} = sample.position;
    this.vehicle.marker.position = C.Cartesian3.fromDegrees(longitude, latitude, altitude);
    this.vehicle.marker.point.color = this.color(sample.color ?? '#ffffff', 1);
    this.vehicle.marker.label.fillColor = this.color(sample.color ?? '#ffffff', 1);
    this.updateLabelText();
    this.vehicle.drop.show = this.visible && !sample.manual && this.display?.paths!==false;
    if (!sample.manual) this.vehicle.drop.polyline.positions = [
      C.Cartesian3.fromDegrees(longitude, latitude, 0),
      C.Cartesian3.fromDegrees(longitude, latitude, altitude)];
    return true;
  }
  updateLabelText() {
    const marker=this.vehicle?.marker;if(!marker?.label)return;
    const boarding=this.sample?.manual?null:boardingAt(this.plan,this.sample?.time_s);
    const status=boarding?.active
      ? `${boarding.phase==='alighting'?'하차 · 시설 이동':'탑승'} ${boarding.boarded}/${boarding.total}명`
      : this.sample?.stage_label??uamPhaseName(this.sample?.stage);
    const base=composeAircraftLabel(this.plan?.vehicle?.id??'UAM',status,this.display);
    const text=this.sample?.manual?`내 조종 · ${base||this.plan?.vehicle?.id||'UAM'}`:base;
    if(this.C?.Color?.fromCssColorString)marker.label.fillColor=this.sample?.manual?this.C.Color.fromCssColorString('#6fffe0'):this.C.Color.WHITE;
    if(this.lastLabelText!==text){marker.label.text=text;this.lastLabelText=text;}
    this.labelHasText=Boolean(text);
    this.labelLineCount=text.split('\n').length;
  }
  updateLabelLayout() {
    const marker=this.vehicle?.marker;
    if (!marker || !this.visible || !this.sample) return;
    const at=this.sample.position;
    const position=this.C.Cartesian3.fromDegrees(at.longitude,at.latitude,at.altitude_m,undefined,this.labelScratch.anchor);
    this.labelScratch.anchor=position;
    const scale=flightLabelScale(this.C,this.scene,position,this.labelScratch);
    const offset=flightLabelOffset(this.C,this.scene,this.modelFailed?null:this.model,position,this.labelOffset,this.labelScratch,this.labelExtent,scale,this.labelLineCount??1);
    const shown=!this.cockpitLabelsHidden&&(this.labelHasText??(this.display?.labels!==false)) && this.display?.aircraft!==false;
    if(this.lastLabelScale!==scale) {marker.label.scale=scale;this.lastLabelScale=scale;}
    if(this.lastLabelShown!==shown) {marker.label.show=shown;this.lastLabelShown=shown;}
    // Avoid reassigning unchanged graphics properties on a stationary frame.
    if (this.lastLabelX!==offset.x || this.lastLabelY!==offset.y) {
      marker.label.pixelOffset=new this.C.Cartesian2(offset.x,offset.y);
      this.lastLabelX=offset.x; this.lastLabelY=offset.y;
    }
  }
  updateControlSurfaces() {
    if(!this.model?.ready || !this.sample || !this.surfaceSpec?.nodes?.length)return;
    if(!this.surfaces){this.surfaces=new ControlSurfacePose(this.C,this.surfaceSpec);this.surfaces.attach(this.model);
      if(this.surfaces.missing.length)this.onWarning('일부 UAM 조종면을 찾지 못했습니다.');}
    this.surfaces.update(this.sample);
  }
  async loadLabelExtent(asset, model) {
    if (!asset.metadata_uri) return;
    const controller=new AbortController();this.labelBoundsAbort=controller;
    const timer=setTimeout(()=>controller.abort(),5000);
    try {
      const response=await fetch(asset.metadata_uri,{signal:controller.signal});
      if (!response.ok) return;
      const extent=(await response.json())?.display?.extent_m;
      if (this.model!==model || !['length','width','height'].every(k=>Number.isFinite(extent?.[k]) && extent[k]>0)) return;
      this.labelExtent=extent;
      this.scene.requestRender?.();
    } catch { /* The public sphere remains a safe fallback without metadata. */ }
    finally {clearTimeout(timer);if(this.labelBoundsAbort===controller)this.labelBoundsAbort=null;}
  }
  // The propellers the library says this airframe has, looked up the first
  // frame the model can answer for its nodes. A model without a rotor record —
  // or one whose export welded the blades into the airframe — simply does not
  // spin, rather than something else being turned in their place.
  attachRotors() {
    if (this.rotors || this.rotorsChecked || !this.rotorSpec) return 0;
    // Before a model is ready its nodes do not exist yet, so asking now would
    // find nothing and conclude the propellers are missing.
    if (!this.model?.ready) return 0;
    this.rotorsChecked = true;
    const spin = new RotorSpin(this.C, this.rotorSpec);
    // A fresh plan defaults to VTOL; a model arriving after a seek must use
    // that current sample instead of resetting a paused cruise to VTOL.
    spin.tilt = tiltOf(this.sample);
    const found = spin.attach(this.model);
    this.rotors = found ? spin : null;
    this.spunAt = 0;
    if (spin.missing.length) {
      this.onWarning(`비행체 모델에서 프로펠러 ${spin.missing.length}개를 찾지 못했습니다.`);
    }
    return found;
  }
  // Turn them by however much real time has passed since the last frame.
  spinRotors(sample) {
    if (!this.rotors) this.attachRotors();
    if (!this.rotors?.attached) return false;
    const now = this.clock();
    const elapsed = this.spunAt ? (now - this.spunAt) / 1000 : 0;
    this.spunAt = now;
    return this.rotors.advance(elapsed, rateOf(sample), tiltOf(sample), flightSpinOf(sample));
  }
  // The catalogue arrived, or a failure is worth another go: try once more.
  retryModel() {
    if (this.model || !this.plan) return Promise.resolve();
    this.modelFailed = false;
    return this.loadModel();
  }
  // What a scene pick landed on: the flight, or null.
  pick(picked) {
    const found = picked?.id?.aerodtFlight ?? (picked?.id?.id?.aerodtFlight);
    return found?.kind === 'vehicle' && this.plan ? {plan: this.plan, sample: this.sample} : null;
  }
  setVisible(visible) {
    this.visible = Boolean(visible);
    this.applyDisplay();
  }
  setCockpitLabelsHidden(hidden) {
    this.cockpitLabelsHidden=Boolean(hidden);this.lastLabelShown=undefined;
    if(this.vehicle?.marker?.label)this.vehicle.marker.label.show=!this.cockpitLabelsHidden&&this.visible&&this.display?.aircraft!==false&&Boolean(this.labelHasText);
    this.scene.requestRender?.();
  }
  setDisplayOptions(state) {this.display={...this.display,...state};this.setVisible(state.all!==false);}
  applyDisplay() {
    for(const entity of this.owned)entity.show=this.visible&&(entity.polyline?this.display?.paths!==false:this.display?.aircraft!==false);
    if(this.vehicle?.drop && this.sample?.manual)this.vehicle.drop.show=false;
    if(this.model)this.model.show=this.visible&&this.display?.aircraft!==false;
    this.lastLabelShown=undefined;
    this.updateLabelText();
    if(this.vehicle?.marker?.label)this.vehicle.marker.label.show=!this.cockpitLabelsHidden&&this.visible&&this.display?.aircraft!==false&&this.labelHasText;
    this.passengers?.update(this.sample?.time_s,!this.sample?.manual&&this.visible&&this.display?.passengers!==false);
      this.turnaround?.update(this.sample,this.model,this.assets(this.plan?.aircraft?.asset_id),this.plan,this.visible&&this.display?.passengers!==false);
      this.updateCabin();
  }
  destroy() {
    this.removeLabelFrame?.(); this.removeLabelFrame=null;
    this.clear(); this.plan = null;
    if (this.models) {this.scene.primitives.remove(this.models); this.models = null;}
  }
}
