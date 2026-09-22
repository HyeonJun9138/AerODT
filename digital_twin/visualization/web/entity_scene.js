import {ManualTurnaround} from './manual_turnaround.js?v=20260921-fleet-ground';
import {cabinAt,showCabin} from './cabin_passengers.js';
import {WholeLabelOcclusion} from './whole_label_occlusion.js';
import {DisplaySamples,chooseLod,displayHeading} from './display_samples.js?v=20260916-steady-playout';
import {loadVisualModel,visualModelScale,visualModelChoice} from './visual_asset_loader.js';
import {projectView,projectMap,categoryRange,drawsSymbol,screenCell,nearLabelPolicy,inLabelBand} from './render_policy.js';
import {RotorSpin} from './rotor_spin.js';
import {ControlSurfacePose} from './control_surface_pose.js';
import {LABEL_FADE_MS,labelFadeAlpha} from './label_fade.js';
import {mapEntityLabel} from './entity_labels.js';
import {ICON_SIZE_PX,iconRotation,paintIcon} from './entity_icon.js';
import {ChargingCables} from './charging_cables.js';

// What emphasis looks like. Hovering is the brighter of the two because it
// answers "this is the one I am about to click"; a selection is already spoken
// for by the open card beside it.
const HOVER_CSS = '#9bdde8';
const HOVER_SILHOUETTE_PX = 3;
const SELECTED_SILHOUETTE_PX = 2;
const articulatedFlight=entity=>entity.source==='scenario' || (entity.kind==='uam' && entity.source==='physical_uam');
const HOVER_GLYPH_SCALE = 1.45;
const SELECTED_GLYPH_SCALE = 1.2;

// How far off a model's name may ignore what is in front of it. A model is only
// drawn while it is more than about six pixels across, which for a ten to
// fifteen metre aircraft on a normal screen is inside two kilometres or so;
// past that the name is depth-tested like every other name on the map.
export const MODEL_LABEL_DEPTH_M = 2500;
// A UAM name obeys the city: a building in front of the aircraft hides its
// name as it hides the aircraft, and past this range the name is not drawn at
// all. Only within the near band, where the aircraft fills the view and the
// name would sink into its own body, does the name sit on top of everything.
// The range grows with the camera's height - a street view names the block, a
// view from twenty kilometres up names the city - and the selected aircraft
// keeps its name at any range, over anything.
export const UAM_LABEL_DEPTH_M = 200;
export const UAM_LABEL_FAR_M = 4000;
export function uamLabelRange(cameraHeight){return Math.max(UAM_LABEL_FAR_M,3*(cameraHeight||0));}
// The room one glyph needs before the next is worth drawing. A dot's cell is
// five pixels because a dot is three; a glyph is drawn at ICON_SIZE_PX, so its
// own footprint is what decides when two of them are one too many.
const glyphCell = (x, y, width) => screenCell(x, y, width, ICON_SIZE_PX);
export const ENTITY_PERFORMANCE_DEFAULTS = Object.freeze({maxModels:24,maxResidentModels:48,
  modelCacheSeconds:20,modelLoads:2,movingModelLoads:1,rotorMinPixels:12});
export const MODEL_PREPARATION_TIMEOUT_MS=10000;
// How long one `prepareFocus` keeps an unready model from being retired for
// being invisible. Refreshed by whoever keeps asking, so it covers a camera
// glide of any length, and short enough that an abandoned arrival stops
// holding the slot within a beat or two of giving up.
export const MODEL_PREPARATION_HOLD_MS=2000;

export class EntityScene {
  constructor(C,viewer,onWarning=()=>{},{surfaceOffset=()=>0}={}) {
    Object.assign(this,{C,viewer,onWarning,surfaceOffset});this.samples=new DisplaySamples();this.items=new Map();this.assets=new Map();
    this.labelOcclusion=new WholeLabelOcclusion(C,viewer,this.items,()=>this.layers.uam?.labels);
    this.removeLabelOcclusion=viewer.scene?.postRender?.addEventListener(()=>this.labelOcclusion.schedule({moving:()=>this.modelsMoving===true}));
    this.array=[0,0,0];this.frameItems=[];this.candidates=[];this.residentModels=new Set();this.pendingModels=0;
    this.lastPointUpdate=-Infinity;this.pointInterval=50;this.disposed=false;this.needsLod=true;
    this.performance={...ENTITY_PERFORMANCE_DEFAULTS};this.modelsMoving=false;
    this.colors={satellite:C.Color.fromCssColorString('#7bddff'),aircraft:C.Color.fromCssColorString('#ffc778'),
      uam:C.Color.fromCssColorString('#8ef2c4'),
      // Injected obstacles. The app's warning hues, so an object somebody put in
      // front of a camera on purpose never reads as one of the fleet.
      drone:C.Color.fromCssColorString('#ff8a94'),bird:C.Color.fromCssColorString('#ffb35c')};this.layers={};
    // What the pointer marks, and what is already open in the card. The hover
    // colour is the app's own accent so a marked object reads as part of the
    // same interface; a selection stays white, which is what the point outline
    // has always used.
    this.hoverColour=C.Color.fromCssColorString(HOVER_CSS);this.selectedColour=C.Color.WHITE;
    // The same three colours the points use, as CSS, because a canvas is
    // painted with strings rather than with Cesium colours.
    this.iconColors={satellite:'#7bddff',aircraft:'#ffc778',uam:'#8ef2c4',drone:'#ff8a94',bird:'#ffb35c'};
    this.createCanvas=(width,height)=>{const canvas=(viewer.scene?.canvas?.ownerDocument ?? globalThis.document).createElement('canvas');
      canvas.width=width;canvas.height=height;return canvas;};
    // How large each asset is drawn, in metres end to end, when something knows
    // better than the file does. Empty means every model comes as it is.
    this.scales=new Map();
    for(const kind of ['aircraft','satellite','uam']) {
      // Billboards are batched: a whole collection is one draw call whatever the
      // count, which is the point of the tier. The collection is made whether or
      // not this Cesium has one, so a stripped build simply has no middle tier
      // rather than throwing.
      const layer={visible:true,points:viewer.scene.primitives.add(new C.PointPrimitiveCollection()),
        billboards:C.BillboardCollection?viewer.scene.primitives.add(new C.BillboardCollection()):null,
        labels:viewer.scene.primitives.add(new C.LabelCollection()),models:viewer.scene.primitives.add(new C.PrimitiveCollection())};
      layer.points.show=layer.labels.show=layer.models.show=true;
      if(layer.billboards)layer.billboards.show=true;
      this.layers[kind]=layer;
    }
    // A drone or a bird is a small, low thing over a city - which is what the
    // uam layer already is. They share it rather than being kinds of their own:
    // every lookup below is by kind, and an unknown kind is silently skipped at
    // replace(), which is how an injected obstacle went undrawn.
    this.layers.drone=this.layers.uam;this.layers.bird=this.layers.uam;
    this.stats={total:0,visible:0,models:0,labels:0,candidates:0};this.fadingLabels=new Set();
  }
  // The glyph for a kind, painted once and shared by every billboard of it.
  icon(kind) {
    this.icons ??= new Map();
    // A painted glyph needs a canvas. Where there is none - a stripped Cesium,
    // a worker, a test - the tier simply does not exist and everything falls
    // back to the dot it used before. It is an addition, so it must not be able
    // to take the map down with it.
    if(!this.icons.has(kind)){
      let painted=null;
      try{painted=paintIcon(kind,this.iconColors[kind] ?? '#ffffff',this.createCanvas);}catch{painted=null;}
      this.icons.set(kind,painted);
    }
    return this.icons.get(kind);
  }
  // The billboard an item is drawn as, made the first time it needs one. An
  // item that never reaches the middle distance never makes one.
  billboardFor(item) {
    const layer=this.layers[item.entity.kind];
    if(item.billboard || !layer?.billboards)return item.billboard ?? null;
    const image=this.icon(item.entity.kind);
    if(!image)return null;
    item.billboard=layer.billboards.add({id:item.entity.entity_id,position:item.position,
      image,width:ICON_SIZE_PX,height:ICON_SIZE_PX,rotation:0,show:false});
    item.billboardAlpha=undefined;
    return item.billboard;
  }
  releaseBillboard(item) {
    if(!item.billboard)return;
    this.layers[item.entity.kind]?.billboards?.remove(item.billboard);
    item.billboard=null;
  }
  pilotOwned(item){return this.manualDisplay?.id===item.entity.entity_id;}
  labelText(item,layer){
    const text=mapEntityLabel(item.entity,{labels:layer.showLabels,status:layer.showStatus});
    return this.pilotOwned(item)?`내 조종 · ${text||item.entity.name||item.entity.entity_id}`:text;
  }
  labelColour(item){return this.pilotOwned(item)?(this.pilotColour??=this.C.Color.fromCssColorString('#6fffe0')):this.C.Color.WHITE;}
  startLabelFade(item,now) {
    item.labelFadeStart=now;item.labelFadeDuration=now<(this.arrivalUntil??0)?this.arrivalDuration:LABEL_FADE_MS;
    item.labelAlpha=0;this.fadingLabels.add(item);
    item.label.fillColor=this.labelColour(item).withAlpha(0);
    item.label.backgroundColor=this.C.Color.BLACK.withAlpha(0);
  }
  fadeLabelsIn(now=performance.now(),duration=LABEL_FADE_MS) {
    this.arrivalStart=now;this.arrivalDuration=duration;this.arrivalUntil=now+duration;
    for(const item of this.items.values())if(item.label)this.startLabelFade(item,now);
    this.updateArrivalPoints(now);
  }
  updateArrivalPoints(now) {
    if(this.arrivalStart===undefined)return;
    const alpha=labelFadeAlpha(now-this.arrivalStart,this.arrivalDuration);
    this.arrivalAlpha=alpha;
    for(const item of this.items.values())this.fadePoint(item);
    if(alpha===1)this.arrivalStart=undefined;
  }
  fadePoint(item) {
    const alpha=this.arrivalAlpha??1;
    if(item.point && item.pointAlpha!==alpha){
      item.point.translucencyByDistance=new this.C.NearFarScalar(0,alpha,1e12,alpha);item.pointAlpha=alpha;
    }
    if(item.billboard && item.billboardAlpha!==alpha){
      item.billboard.translucencyByDistance=new this.C.NearFarScalar(0,alpha,1e12,alpha);item.billboardAlpha=alpha;
    }
  }
  updateLabelFades(now) {
    this.updateArrivalPoints(now);
    for(const item of this.fadingLabels){
      if(!item.label || this.items.get(item.entity.entity_id)!==item){this.fadingLabels.delete(item);continue;}
      const alpha=labelFadeAlpha(now-item.labelFadeStart,item.labelFadeDuration);item.labelAlpha=alpha;
      item.label.fillColor=this.labelColour(item).withAlpha(alpha);
      item.label.backgroundColor=this.C.Color.BLACK.withAlpha((item.labelSmall?.55:.7)*alpha);
      if(alpha===1)this.fadingLabels.delete(item);
    }
  }
  releaseModel(item) {
    item.modelRevision=(item.modelRevision??0)+1;
    item.removeModelReady?.();item.removeModelReady=null;
    item.removeModelError?.();item.removeModelError=null;
    item.removeModelTextures?.();item.removeModelTextures=null;
    if(item.model){
      if(item.modelAttached===false)item.model.destroy();
      else this.layers[item.entity.kind].models.remove(item.model);
    }
    item.rotors?.detach();item.rotors=null;item.rotorsChecked=false;item.spunAt=0;
    item.controlSurfaces=null;item.controlSurfaceSpec=null;item.controlSurfaceSample=null;
    item.model=null;item.modelAttached=false;item.modelAttachmentDirty=false;this.residentModels.delete(item);
  }
  attachModelForFrame(item,active) {
    if(!item.model)return;
    const attached=item.modelAttached!==false;if(attached===active)return;
    const collection=this.layers[item.entity.kind].models;
    if(active){
      // A warm model can have travelled a long way while absent from the scene.
      if(this.C.Transforms)item.model.modelMatrix=this.matrix(item);
      collection.add(item.model);
    }else{
      // Model.show=false still updates Cesium's scene graph and environment map.
      // Retain ready offscreen models outside the render collection so the warm
      // cache costs memory only. PrimitiveCollection's public ownership flag
      // transfers the resource without destroying shared GLB/GPU buffers.
      const destroy=collection.destroyPrimitives;collection.destroyPrimitives=false;
      try{collection.remove(item.model);}finally{collection.destroyPrimitives=destroy;}
    }
    item.modelAttached=active;
  }
  // Only browser rendering budgets change here; samples and flight clocks do not.
  setPerformanceOptions(options={}) {
    const bounds={maxModels:[1,160],maxResidentModels:[2,256],modelCacheSeconds:[0,120],
      modelLoads:[1,8],movingModelLoads:[0,4],rotorMinPixels:[0,64]};
    for(const [key,[low,high]] of Object.entries(bounds))if(Number.isFinite(options[key]))
      this.performance[key]=Math.min(high,Math.max(low,key==='modelCacheSeconds'?options[key]:Math.round(options[key])));
    this.performance.maxResidentModels=Math.max(this.performance.maxModels+1,this.performance.maxResidentModels);
    this.performance.movingModelLoads=Math.min(this.performance.modelLoads,this.performance.movingModelLoads);
    this.trimModels(performance.now());this.needsLod=true;this.lodScan=null;
  }
  preparingModels() {
    let count=this.pendingModels;
    for(const item of this.residentModels)if(item.model?.ready===false && !item.failed)count++;
    return count;
  }
  retirePreparation(now=performance.now()) {
    for(const item of this.residentModels){
      if(item.model?.ready!==false||item.failed)continue;
      // A model can be loading deliberately without owning the selection.
      // Arriving at an aircraft asks for its model while the camera is still
      // gliding towards it, and until the glide lands the target is far enough
      // off to be 'hidden' -- so this rule would release the very load the glide
      // was meant to be overlapping, and the next beat would start it again.
      const held=(item.modelHeldUntil??0)>now;
      const unused=item.lod==='hidden'&&!item.selected&&!held&&!this.destinationItems?.has(item);
      item.modelUnusedSince=unused?(item.modelUnusedSince??now):null;
      // Ready models keep their warm cache; unready invisible work must not
      // occupy the only moving-camera preparation slot indefinitely.
      if(unused&&now-item.modelUnusedSince>=750){this.releaseModel(item);this.needsLod=true;continue;}
      if(now-(item.modelPreparedAt??now)>=MODEL_PREPARATION_TIMEOUT_MS){
        this.modelFailed(item);this.releaseModel(item);this.applyVisibility(item,item.selected);this.needsLod=true;
      }
    }
  }
  modelStats() {
    let attachedModels=0,readyModels=0,warmModels=0;
    for(const item of this.residentModels){
      if(item.modelAttached!==false)attachedModels++;
      if(item.model?.ready!==false && !item.failed){
        if(item.modelAttached===false)warmModels++;
        else if(item.model?.show)readyModels++;
      }
    }
    return {residentModels:this.residentModels.size,pendingModels:this.pendingModels,
      preparingModels:this.preparingModels(),attachedModels,readyModels,warmModels};
  }
  trimModels(now,reserve=0) {
    const unused=[];
    for(const item of this.residentModels)if(item.lod!=='model' && !item.selected && !this.destinationItems?.has(item))unused.push(item);
    unused.sort((a,b)=>a.lastModelUse-b.lastModelUse);
    for(const item of unused)if(now-item.lastModelUse>this.performance.modelCacheSeconds*1000
      || this.residentModels.size+this.pendingModels+reserve>this.performance.maxResidentModels)this.releaseModel(item);
  }
  setLayerVisible(kind,visible) {
    const layer=this.layers[kind];if(!layer)throw new Error('Unknown visual layer');
    layer.visible=Boolean(visible);layer.points.show=layer.labels.show=layer.models.show=layer.visible;
    if(!layer.visible)for(const [id,item] of this.items)if(this.layers[item.entity.kind]===layer)this.chargingCables?.remove(id);
    layer.labels.show=layer.visible&&(layer.showLabels!==false||(kind==='uam'&&layer.showStatus!==false));
    layer.models.show=layer.visible&&layer.showModels!==false;
    for(const item of this.items.values())if(item.entity.kind===kind && !layer.visible){
      this.releaseModel(item);this.releaseBillboard(item);if(item.label){layer.labels.remove(item.label);item.label=null;}item.lod='hidden';item.point.show=false;
    }
    this.frameItems=this.frameItems.filter(item=>this.layers[item.entity.kind].visible);this.needsLod=true;this.lodScan=null;
  }
  setDisplayOptions(kind,{labels=true,status=true,models=true}={}) {
    const layer=this.layers[kind];if(!layer)return;
    layer.showLabels=Boolean(labels);layer.showStatus=kind==='uam'&&Boolean(status);layer.showModels=Boolean(models);
    layer.labels.show=layer.visible&&(layer.showLabels||layer.showStatus);layer.models.show=layer.visible&&layer.showModels;
    for(const item of this.items.values())if(item.entity.kind===kind){
      if(item.label){item.label.text=this.labelText(item,layer);item.label.show=Boolean(item.label.text)&&!item.labelOccluded;}
      if(!layer.showModels && (item.model || item.loading))this.releaseModel(item);
      if(!layer.showModels && item.lod==='model')item.lod='billboard';
      this.applyVisibility(item,item.selected);
    }
    this.needsLod=true;this.lodScan=null;
  }
  applyVisibility(item,selected=false,deferModelTransfer=false) {
    const visible=this.layers[item.entity.kind].visible && item.lod!=='hidden';
    const modelWanted=visible && this.layers[item.entity.kind].showModels!==false && item.lod==='model' && !!item.model && !item.failed;
    // Parsing a GLB is not GPU readiness. Keep the glyph until Cesium can draw
    // the model, while allowing the model to prepare its asynchronous resources.
    const modelVisible=modelWanted && item.model.ready!==false;
    if(item.model){item.model.show=modelWanted;item.modelWasReady=item.model.ready!==false;
      if(!deferModelTransfer)this.attachModelForFrame(item,Boolean(modelWanted || (!item.failed && (item.model.ready===false || item.modelTexturesReady===false))));
      item.modelAttachmentDirty=deferModelTransfer;}
    // A model still loading falls back to its glyph rather than to a dot, so an
    // aircraft does not shrink to three pixels while its file arrives. A model
    // that FAILED still falls back to the point: that is what the warning tells
    // the operator, and a broken asset should look like a broken asset rather
    // than like a smaller aircraft.
    const wantsGlyph=visible && !modelVisible
      && (item.lod==='billboard' || (item.lod==='model' && !item.failed));
    const glyph=wantsGlyph?this.billboardFor(item):item.billboard;
    if(glyph){glyph.show=wantsGlyph;glyph.width=glyph.height=item.lod==='model'?28:ICON_SIZE_PX;}
    // No glyph could be made: the dot is what is left, exactly as before.
    const glyphVisible=wantsGlyph && Boolean(glyph);
    item.point.show=visible && !glyphVisible && (!modelVisible || (selected && item.pixels<3));
    item.point.pixelSize=selected?6:item.hovered?7:3;item.point.outlineWidth=selected || item.hovered?1.5:0;
    item.point.outlineColor=item.hovered?this.hoverColour:this.selectedColour;
    if(this.arrivalAlpha!==undefined)this.fadePoint(item);
    // Whatever the object is drawn as, hovering it has to show. Only the dot
    // used to change, so an aircraft near enough to be a model or a glyph --
    // which is most of the time an operator is trying to click one -- gave no
    // sign at all of what was about to be picked.
    this.emphasise(item,selected);
  }
  // The pointer is over this one, or it is the selected one. A model gets an
  // outline drawn around it, a glyph grows; both read at a glance without
  // moving anything or changing what the object is.
  emphasise(item,selected=false) {
    const marked=Boolean(item.hovered || selected);
    const colour=item.hovered?this.hoverColour:this.selectedColour;
    if(item.model){
      item.model.silhouetteColor=colour;
      item.model.silhouetteSize=marked?(item.hovered?HOVER_SILHOUETTE_PX:SELECTED_SILHOUETTE_PX):0;
    }
    if(item.billboard){
      item.billboard.scale=marked?(item.hovered?HOVER_GLYPH_SCALE:SELECTED_GLYPH_SCALE):1;
      item.billboard.color=marked?colour:this.C.Color.WHITE;
    }
  }
  setHovered(id) {
    if(this.hoveredId===id)return;
    const previous=this.items.get(this.hoveredId);if(previous){previous.hovered=false;this.applyVisibility(previous,previous.selected);}
    this.hoveredId=id;
    const item=this.items.get(id);if(item){item.hovered=true;this.applyVisibility(item,item.selected);}
  }
  setAssets(catalog){for(const asset of catalog.assets ?? [])if(asset.uri?.startsWith('/visual-assets/'))this.assets.set(asset.asset_id,asset);this.needsLod=true;}
  // {asset_id: metres}. Models already loaded at another size are let go so the
  // next scan builds them again at the new one.
  setModelSpans(spans){
    const next=new Map(Object.entries(spans ?? {}).filter(([,metres])=>Number(metres)>0).map(([id,metres])=>[id,Number(metres)]));
    let changed=next.size!==this.scales.size;
    for(const [id,metres] of next)if(this.scales.get(id)!==metres)changed=true;
    if(!changed)return;
    this.scales=next;
    for(const item of this.items.values())if(item.model || item.loading)this.releaseModel(item);
    this.needsLod=true;
  }
  // What the thing measures on screen: the size it is drawn at, which is the
  // span when one was given and the file's own extent when it was not.
  sizeOf(assetId,scenario=false){const asset=this.assets.get(assetId);return this.scales.get(assetId) ?? (scenario?asset?.flight_visual?.size_m:null) ?? asset?.size_m ?? 0;}
  // What the file has to be multiplied by to measure that. The scheduled day
  // and the physical twin draw one shared flight rig for every cabin class, so
  // it is scaled to the size that airframe's own metadata gives its class; an
  // acquired library model is already at its documented size, so it is drawn
  // as authored unless a span was pushed in. A rig that never declared what it
  // measures is left alone rather than guessed at.
  scaleOf(assetId,scenario=false){
    return visualModelScale(this.assets.get(assetId),{flight:scenario,span:this.scales.get(assetId)});
  }
  // The file and the scale as one answer. Every view of an item asks here,
  // so no caller can end up drawing one model at the other one's size.
  visualOf(item){
    return visualModelChoice(this.assets.get(item.assetId),{flight:articulatedFlight(item.entity),span:this.scales.get(item.assetId)});
  }
  // Take one source off the map now, rather than waiting for the wire to stop
  // carrying it. Closing the day's console is the operator saying that day is no
  // longer what the twin is showing; if the stream were slow, stale or refused,
  // its aircraft would otherwise stand on the map as though they still were.
  // Everything of one source, taken off the map at once - the scheduled day is
  // handed back, and its aircraft stop being the twin's state that instant.
  //
  // The source is also disowned until the server agrees. A snapshot encoded
  // before the hand-back and delivered after it still carries every one of
  // those aircraft, and putting them back would strand them there for good:
  // the server never sends them again, so nothing would ever remove them. That
  // is what a day that "will not turn off" looks like from the operator's chair.
  dropSource(source) {
    (this.disowned ??= new Set()).add(source);
    let dropped=0;
    for(const [id,item] of this.items)if(item.entity?.source===source) {
      const layer=this.layers[item.entity.kind];
      layer.points.remove(item.point);if(item.label)layer.labels.remove(item.label);
      this.releaseModel(item);this.releaseBillboard(item);this.items.delete(id);this.samples.forget(id);dropped++;
    }
    this.chargingCables?.retain([...this.items.values()].map(item=>item.entity));
    this.frameItems=this.frameItems.filter(item=>this.items.get(item.entity.entity_id)===item);
    this.fadingLabels=new Set([...this.fadingLabels].filter(item=>this.items.get(item.entity.entity_id)===item));
    this.needsLod=true;this.stats.total=this.items.size;
    return dropped;
  }
  // The source is expected again: a day put back on the map is the twin's state
  // once more, and its aircraft are to be drawn.
  ownSource(source) {return Boolean(this.disowned?.delete(source));}
  // A scenario's airframes are prepared when the day first shows them parked,
  // not when the first one takes off in front of the camera. One anchor model
  // per asset is loaded, drawn once under the ground (so nothing flashes) and
  // then hidden but kept: its glTF buffers, textures and every program stay
  // resident, so the aircraft that later appear are cache hits instead of a
  // 1-2 s parse, upload and Direct3D link wait each (measured 3.6-5.2 s for
  // two). One at a time, so the map does not stall for all of them at once.
  warmAsset(assetId) {
    if(!assetId || this.disposed || !this.viewer?.scene?.camera)return false;
    this.warmed??=new Map();
    if(this.warmed.has(assetId))return false;
    const base=this.assets.get(assetId);
    const asset=base?.flight_visual?{...base,...base.flight_visual}:base;
    if(!asset?.uri)return false;
    const entry={model:null,pending:true,showUntil:0};
    this.warmed.set(assetId,entry);
    this.warmQueue=(this.warmQueue??Promise.resolve())
      .then(()=>this.loadWarmAsset(assetId,asset,entry)).catch(()=>{});
    return true;
  }
  async loadWarmAsset(assetId,asset,entry) {
    const C=this.C,scene=this.viewer.scene,camera=scene.camera;
    if(this.disposed)return;
    try {
      // Ahead of the camera and below the ground there: inside the frustum, so
      // it is drawn and its programs compiled, and behind the terrain, so it
      // is not seen.
      const carto=camera.positionCartographic;
      const ahead=Math.max(300,(carto?.height??0)*.02);
      const p=camera.positionWC,d=camera.directionWC;
      const position=C.Cartesian3.fromElements?.(p.x+d.x*ahead,p.y+d.y*ahead,p.z+d.z*ahead) ?? {x:p.x+d.x*ahead,y:p.y+d.y*ahead,z:p.z+d.z*ahead};
      let matrix=C.Matrix4?.fromTranslation?.(position);
      if(C.Cartographic?.fromCartesian && scene.globe?.getHeight){
        const at=C.Cartographic.fromCartesian(position);
        if(at){const ground=scene.globe.getHeight(at);at.height=(Number.isFinite(ground)?ground:0)-200;
          matrix=C.Matrix4.fromTranslation(C.Cartographic.toCartesian?.(at)??C.Cartesian3.fromRadians(at.longitude,at.latitude,at.height));}
      }
      const model=await loadVisualModel(C,asset,`warm:${assetId}`,matrix,undefined,
        this.scaleOf(assetId,Boolean(this.assets.get(assetId)?.flight_visual)));
      if(this.disposed){model.destroy();return;}
      // Hidden while it loads (Cesium still prepares a hidden model), shown
      // for a moment once it is ready, hidden again by settleWarmAssets().
      model.show=false;
      entry.model=this.layers.uam.models.add(model);
      // fromGltfAsync returns before GPU preparation. Keep the queue occupied
      // through readyEvent and the short shader warm-up, not merely the fetch.
      await new Promise(resolve=>{
        entry.complete=resolve;
        entry.listeners=[];
        entry.timer=setTimeout(()=>this.finishWarmAsset(entry,true),MODEL_PREPARATION_TIMEOUT_MS);
        const shown=()=>{if(this.disposed || !entry.pending || entry.model!==model)return;
          model.show=true;entry.showUntil=performance.now()+250;scene.requestRender?.();};
        if(model.ready===true)shown();else entry.listeners.push(model.readyEvent?.addEventListener(shown));
        entry.listeners.push(model.errorEvent?.addEventListener(()=>this.finishWarmAsset(entry,true)));
        scene.requestRender?.();
      });
    } catch {this.finishWarmAsset(entry,true);}
  }
  finishWarmAsset(entry,failed=false) {
    clearTimeout(entry.timer);
    for(const remove of entry.listeners??[])remove?.();
    entry.listeners=[];entry.pending=false;entry.showUntil=0;
    if(entry.model){entry.model.show=false;
      if(failed){this.layers.uam.models.remove(entry.model);entry.model=null;}}
    const complete=entry.complete;entry.complete=null;complete?.();
  }
  // The anchors drawn for their moment are hidden again here, every frame.
  settleWarmAssets(now) {
    if(!this.warmed)return;
    for(const entry of this.warmed.values()){
      if(entry.model && entry.showUntil && now>=entry.showUntil)this.finishWarmAsset(entry);
    }
  }
  replace(snapshot) {
    snapshot=this.withoutDisowned(snapshot);
    if(!this.samples.replace(snapshot,performance.now()))return;
    const C=this.C;
    for(const [id,sample] of this.samples.entries){
      const layer=this.layers[sample.entity.kind];if(!layer)continue;
      let item=this.items.get(id);
      if(!item){const position=C.Cartesian3.fromArray(sample.entity.position_ecef_m);
        item={position,lod:'hidden',model:null,loading:false,failed:false,label:null,
          point:layer.points.add({id,position,pixelSize:3,color:this.colors[sample.entity.kind],outlineWidth:0,show:false})};this.items.set(id,item);
        if(sample.entity.kind==='uam' && sample.entity.source==='scenario')this.warmAsset(sample.entity.visual_asset_id);}
      item.entity=sample.entity;
      if(item.label){const text=this.labelText(item,layer);
        if(item.label.text!==text)item.label.text=text;item.label.show=Boolean(text)&&!item.labelOccluded;}
      if(item.assetId!==sample.entity.visual_asset_id){this.releaseModel(item);item.failed=false;item.assetId=sample.entity.visual_asset_id;}
    }
    for(const [id,item] of this.items)if(!this.samples.entries.has(id)){
      const layer=this.layers[item.entity.kind];layer.points.remove(item.point);if(item.label)layer.labels.remove(item.label);
      this.releaseModel(item);this.releaseBillboard(item);this.items.delete(id);
    }
    this.chargingCables?.retain([...this.items.values()].map(item=>item.entity));
    this.frameItems=this.frameItems.filter(item=>this.items.get(item.entity.entity_id)===item);
    this.needsLod=true;this.stats.total=this.items.size;
  }
  // A snapshot with nothing of a disowned source in it is the server having
  // caught up, so the source is accepted again from the next one. Until then
  // its entities are taken out of the frame rather than drawn.
  withoutDisowned(snapshot) {
    if(!this.disowned?.size)return snapshot;
    const entities=snapshot.entities ?? [];
    const present=new Set();
    for(const entity of entities)if(this.disowned.has(entity.source))present.add(entity.source);
    for(const source of [...this.disowned])if(!present.has(source))this.disowned.delete(source);
    if(!present.size)return snapshot;
    return {...snapshot,entities:entities.filter(entity=>!present.has(entity.source))};
  }
  prepareFocus(item,now=performance.now()) {
    if(!item || this.layers[item.entity.kind]?.showModels===false || !this.assets.has(item.assetId))return false;
    // The hold goes on before the sweep, or this call retires its own request.
    item.lastModelUse=now;item.modelHeldUntil=now+MODEL_PREPARATION_HOLD_MS;this.retirePreparation(now);
    if(!item.model)void this.loadModel(item,true);
    return item.loading===true || item.model?.ready===false;
  }
  async loadModel(item,priority=false) {
    if(item.failed && (item.modelFailures??0)>0 && (item.modelFailures??0)<3 && performance.now()>=(item.modelRetryAt??Infinity)){
      this.releaseModel(item);item.failed=false;
    }
    const base=this.assets.get(item.assetId);
    // One decision for the file and the size it is drawn at: visual.flight is
    // the same test the merge used to make on its own, and visual.scale is the
    // scale that goes with the file it chose.
    const visual=this.visualOf(item);
    const asset=visual.flight?{...base,...base.flight_visual}:base;
    // Destination preparation reorders the queue; it does not increase GPU
    // concurrency. An explicitly selected single aircraft keeps its own slot.
    if(!priority&&this.destinationItems?.size&&!this.destinationItems.has(item)&&
       [...this.destinationItems].some(target=>!target.failed&&!target.model))return;
    const limit=priority===true?this.performance.modelLoads+1:(this.modelsMoving?this.performance.movingModelLoads:this.performance.modelLoads);
    if(priority===true&&!item.model&&!item.loading&&this.preparingModels()>=limit){
      const stale=[...this.residentModels].find(other=>other!==item&&!other.selected&&other.model?.ready===false&&
        (other.lod==='hidden'||other.modelPriority)&&!this.destinationItems?.has(other));
      if(stale)this.releaseModel(stale);
    }
    if(!visual.uri || item.model || item.loading || item.failed || this.disposed || this.preparingModels()>=limit)return;
    this.trimModels(performance.now(),1);
    if(this.residentModels.size+this.pendingModels>=this.performance.maxResidentModels)return;
    item.loading=true;this.pendingModels++;const assetId=item.assetId,revision=item.modelRevision;
    try {
      const model=await loadVisualModel(this.C,visual,item.entity.entity_id,this.matrix(item),undefined,visual.scale);
      const layer=this.layers[item.entity.kind];
      if(this.disposed || this.items.get(item.entity.entity_id)!==item || item.assetId!==assetId || item.modelRevision!==revision || !layer.visible || layer.showModels===false){model.destroy();return;}
      item.rotorSpec=articulatedFlight(item.entity)?asset.rotors:null;
      item.controlSurfaceSpec=item.rotorSpec?.control_surfaces;
      item.model=layer.models.add(model);item.modelAttached=true;this.residentModels.add(item);item.lastModelUse=performance.now();
      item.modelPreparedAt=item.lastModelUse;item.modelUnusedSince=null;item.modelPriority=priority===true;
      item.modelTexturesReady=model.ready!==false || !model.texturesReadyEvent;
      this.applyVisibility(item,item.selected);
      item.removeModelReady=model.readyEvent?.addEventListener(()=>{
        if(this.disposed || item.model!==model)return;
        this.applyVisibility(item,item.selected);this.needsLod=true;this.viewer.scene.requestRender?.();
      });
      item.removeModelError=model.errorEvent.addEventListener(()=>{if(item.model!==model)return;
        // Model errors can also arrive inside primitive traversal. Show the
        // fallback immediately and transfer the failed resource next frame.
        this.modelFailed(item);this.applyVisibility(item,item.selected,true);});
      item.removeModelTextures=model.texturesReadyEvent?.addEventListener(()=>{
        if(this.disposed || item.model!==model)return;
        // This event runs inside Cesium's primitive traversal. Defer collection
        // changes until our next frame/LOD update so no sibling is skipped.
        item.modelTexturesReady=true;item.modelAttachmentDirty=true;this.needsLod=true;this.viewer.scene.requestRender?.();
      });
      this.viewer.scene.requestRender?.();
    }catch{if(!this.disposed && this.items.get(item.entity.entity_id)===item && item.assetId===assetId && item.modelRevision===revision)this.modelFailed(item);}
    finally{item.loading=false;this.pendingModels--;this.needsLod=true;
      if(!this.disposed)this.viewer.scene.requestRender?.();}
  }
  modelFailed(item) {
    item.failed=true;item.modelFailures=(item.modelFailures??0)+1;
    item.modelRetryAt=performance.now()+(item.modelFailures===1?5000:30000);
    if(item.modelFailures===1)this.onWarning('3D 모델 준비 지연 · 위치 표시는 유지하며 잠시 후 다시 시도합니다.');
  }
  // Orientation follows the same interpolated display time as the position, so a
  // new ground-track sample turns the model over the interval instead of snapping.
  // Render the pilot's existing smoothed socket sample on the fleet model.
  // Never write this presentation override into the fleet observation buffer.
  setManualSample(id,sample,plan=null){
    const previous=this.manualDisplay?.id;this.manualDisplay=id&&sample?{id,sample,plan}:null;
    if(previous===this.manualDisplay?.id)return;
    this.manualTurnaround?.clear();
    this.needsLod=true;this.lodScan=null;
    for(const key of [previous,this.manualDisplay?.id]){
      const item=this.items?.get(key);if(!item?.label)continue;
      item.label.text=this.labelText(item,this.layers[item.entity.kind]);
      item.label.fillColor=this.labelColour(item).withAlpha(item.labelAlpha??1);
    }
  }
  updateManualGround(shown=true){
    const frame=this.manualDisplay,item=this.items.get(frame?.id);
    if(!frame?.plan||!item){this.manualTurnaround?.clear();return;}
    const {sample,plan}=frame,asset=this.assets.get(item.assetId),g=sample.ground_handling;
    this.manualTurnaround??=new ManualTurnaround(this.C,this.viewer,{assets:id=>this.assets.get(id),warning:this.onWarning});
    const visible=shown&&this.layers[item.entity.kind]?.visible!==false;
    this.manualTurnaround.update(sample,item.model,asset,plan,visible);
    // The native/manual sample owns cabin progress, not the fleet polling clock.
    const seats=g?.walk?cabinAt(null,{walk:g.walk,phase:'alighting',elapsed_s:sample.time_s-g.start_s-2}).seats
      :Array.from({length:sample.passengers??plan.vehicle?.passengers??0},(_,i)=>i);
    showCabin(this.C,item.model,asset?.cockpit,visible?seats:[]);
  }
  manualSample(item){return this.manualDisplay?.id===item.entity.entity_id?this.manualDisplay.sample:null;}
  matrix(item,stateTime=this.samples.renderTime(item.entity.entity_id)) {
    const C=this.C;item.hpr ??= new C.HeadingPitchRoll();
    const manual=this.manualSample?.(item);
    if(manual){
      item.hpr.heading=((manual.heading_deg??0)-90)*Math.PI/180;
      item.hpr.pitch=(manual.pitch_deg??0)*Math.PI/180;item.hpr.roll=(manual.roll_deg??0)*Math.PI/180;
      return C.Transforms.headingPitchRollToFixedFrame(item.position,item.hpr,C.Ellipsoid.WGS84,undefined,item.matrix);
    }
    item.hpr.heading=displayHeading(item.entity,this.samples.headingAt(item.entity.entity_id,stateTime));item.hpr.pitch=item.hpr.roll=0;
    if(item.entity.orientation_source==='attitude'){
      item.telemetry=this.samples.telemetryAt(item.entity.entity_id,stateTime,item.telemetry ?? {});
      item.hpr.pitch=(item.telemetry.pitch_deg ?? 0)*Math.PI/180;
      item.hpr.roll=(item.telemetry.roll_deg ?? 0)*Math.PI/180;
    }
    return C.Transforms.headingPitchRollToFixedFrame(item.position,item.hpr,C.Ellipsoid.WGS84,undefined,item.matrix);
  }
  refreshPosition(item,now) {
    const manual=this.manualSample?.(item),p=manual?.position;
    if(p&&[p.longitude,p.latitude,p.altitude_m].every(Number.isFinite)){
      this.C.Cartesian3.fromDegrees(p.longitude,p.latitude,p.altitude_m,this.C.Ellipsoid.WGS84,item.position);return;
    }
    this.samples.position(item.entity.entity_id,now,this.array);this.C.Cartesian3.fromArray(this.array,0,item.position);
    this.surfaceLift(item,now);
  }
  // A reported geometric altitude can sit below the rendered terrain: GNSS
  // height noise on a parked or landed aircraft, or a stale estimate held at
  // its last value. The state stays as reported and the panel shows it; only
  // the drawn position is lifted onto the surface, so nothing is shown
  // underground. Terrain changes slowly, so the height is sampled twice a
  // second and only for aircraft that are low and on screen.
  surfaceLift(item,now) {
    const entity=item.entity,globe=this.viewer.scene?.globe;
    if(['scenario','physical_uam'].includes(entity.source) && entity.kind==='uam'){
      this.alignDeck(item);return;
    }
    if(entity.kind!=='aircraft' || !(entity.altitude_m<2000) || !globe?.getHeight)return;
    if((item.lod!=='hidden' || item.selected) && now-(item.liftSampledAt ?? -Infinity)>=500){
      item.liftSampledAt=now;
      const carto=this.liftScratch ??= {longitude:0,latitude:0,height:0};
      carto.longitude=entity.longitude_deg*Math.PI/180;carto.latitude=entity.latitude_deg*Math.PI/180;
      const ground=globe.getHeight(carto);
      item.lift=Number.isFinite(ground)?Math.max(0,ground+3-entity.altitude_m):0;
    }
    if(!(item.lift>0))return;
    const p=item.position,radius=Math.hypot(p.x,p.y,p.z);
    if(radius>0){const k=item.lift/radius;p.x+=p.x*k;p.y+=p.y*k;p.z+=p.z*k;}
  }
  // Register a scenario's display against its own deck, not an arbitrary
  // nearby rooftop. Both ends of the buffered sample use the same display
  // time. No terrain requests, GLB resizing, or writes to simulation state.
  alignDeck(item) {
    const t=this.samples.renderTime(item.entity.entity_id);
    const refs=this.samples.surfaceAt(item.entity.entity_id,t,item.surfaceRefs ??= {});
    if(!refs.from && !refs.to)return;
    const ellipsoid=this.C.Ellipsoid.WGS84;
    const carto=ellipsoid.cartesianToCartographic(item.position,item.surfaceCarto);
    if(!carto)return;
    item.surfaceCarto=carto;
    const same=refs.from===refs.to || (refs.from && refs.to && refs.from.vertiport_id===refs.to.vertiport_id && refs.from.altitude_m===refs.to.altitude_m);
    const a=this.surfaceOffset(refs.from,carto),b=same?a:this.surfaceOffset(refs.to,carto);
    const offset=a+(b-a)*refs.fraction;
    if(!Number.isFinite(offset) || Math.abs(offset)<1e-6)return;
    carto.height+=offset;
    // A geodetic normal, not an ECEF radial lift (which also shifts latitude).
    ellipsoid.cartographicToCartesian(carto,item.position);
  }
  updatePositions(now) {
    if(now-(this.lastCableUpdate??-Infinity)>=250){
      this.lastCableUpdate=now;
      this.chargingCables??=new ChargingCables(this.C,this.viewer,{cabinet:connection=>this.chargerCabinet?.(connection)??null});
      this.chargingCables.update(this.items.values(),item=>this.layers[item.entity.kind]?.visible,item=>{
        const carto=this.C.Ellipsoid?.WGS84?.cartesianToCartographic(item.position);
        return carto?carto.height-item.entity.altitude_m:0;
      });
    }
    this.settleWarmAssets(now);
    const pointsDue=now-this.lastPointUpdate>=this.pointInterval;if(pointsDue)this.lastPointUpdate=now;
    // Hidden/frustum-culled objects are evaluated by the slower LOD scan only.
    // Models, the selection and near objects (>= 1 px apparent size) follow the
    // render frame; distant points keep the slower point cadence.
    for(const item of this.frameItems){
      if(!this.layers[item.entity.kind].visible || item.lod==='hidden')continue;
      if(item.model && (item.modelAttachmentDirty || item.modelWasReady!==(item.model.ready!==false)))this.applyVisibility(item,item.selected);
      if(!pointsDue && item.lod!=='model' && !item.selected && !(item.pixels>=1))continue;
      this.refreshPosition(item,now);
      if(item.point.show)item.point.position=item.position;
      if(item.label)item.label.position=item.position;
      if(item.model && item.lod==='model'){item.matrix=this.matrix(item);item.model.modelMatrix=item.matrix;this.spinRotors(item,now);this.updateControlSurfaces(item);}
      // The glyph turns on the same interpolated display time the model would
      // have used, so an aircraft turns over the interval rather than snapping
      // when the next sample lands.
      if(item.billboard?.show){
        item.billboard.position=item.position;
        const id=item.entity.entity_id;
        item.billboard.rotation=iconRotation(item.entity.kind,
          this.samples.headingAt(id,this.samples.renderTime(id)));
      }
    }
  }
  spinRotors(item,now) {
    if(!item.rotorSpec || !item.model?.ready)return;
    const physical=item.entity.source==='physical_uam';
    if(!item.rotorsChecked){
      item.rotorsChecked=true;const spin=new RotorSpin(this.C,item.rotorSpec);
      if(spin.attach(item.model))item.rotors=spin;
    }
    if(!item.rotors)return;
    const manual=this.manualSample?.(item);
    const stateTime=manual?.time_s??this.samples.renderTime(item.entity.entity_id);
    const moving=Number.isFinite(item.spinStateTime) && stateTime>item.spinStateTime;
    item.spinStateTime=stateTime;
    // Below this apparent size individual blades are subpixel. Preserve the
    // measured nacelle tilt, but stop dirtying every rotor node each frame.
    const detailed=item.selected || !(item.pixels<this.performance.rotorMinPixels);
    // A stale navigation fix is not a motor shutdown. Physical blades use real
    // frame time and the buffered measured RPM even when position time stops.
    // This is cosmetic only: no extension of position/attitude validity, and
    // no assumed RPM for absent actuator readings. Scenario pause still holds.
    const dt=detailed && (physical || moving) && item.spunAt?(now-item.spunAt)/1000:0;item.spunAt=now;
    const t=manual??this.samples.telemetryAt(item.entity.entity_id,stateTime,item.telemetry ?? {});
    const flying=manual?manual.airborne!==false:!['parked','gate_in','gate_out','charge'].includes(item.entity.flight_phase);
    const rate=physical && (!Number.isFinite(item.entity.rotor_radps)||!Number.isFinite(t.rotor_radps))?0:t.rotor_radps ?? 0;
    const tilt=physical && (!Number.isFinite(item.entity.tilt_deg)||!Number.isFinite(t.tilt_deg))?item.rotors.tilt:(t.tilt_deg ?? 0)*Math.PI/180;
    item.rotors.advance(dt,rate,tilt,flying);
  }
  updateControlSurfaces(item) {
    if(!item.model?.ready || !item.controlSurfaceSpec?.nodes?.length)return;
    if(!item.controlSurfaces){
      item.controlSurfaces=new ControlSurfacePose(this.C,item.controlSurfaceSpec);
      item.controlSurfaces.attach(item.model);
      if(item.controlSurfaces.missing.length)this.onWarning('일부 UAM 조종면을 찾지 못했습니다.');
    }
    const t=this.samples.renderTime(item.entity.entity_id);
    const sample=this.manualSample?.(item)??this.samples.controlSurfaceAt(item.entity.entity_id,t,item.controlSurfaceSample??={});
    if(!sample)return;
    // Low-speed/vertical observations are already neutralized by the shared
    // display proxy. Never use the newest packet's phase at an older playhead.
    if(!this.manualSample?.(item))sample.airborne=true;
    item.controlSurfaces.update(sample);
  }
  // The camera pose a scan projects against. A scan spans several frames and
  // a pursuit moves the camera every frame, so every chunk re-reads it; judged
  // against a camera a few frames old, a fast object is already off screen.
  captureView(camera) {
    const C=this.C,scene=this.viewer.scene;
    this.occluder ??= new C.EllipsoidalOccluder(C.Ellipsoid.WGS84,camera.positionWC);this.occluder.cameraPosition=camera.positionWC;
    const pos=camera.positionWC,dir=camera.directionWC,up=camera.upWC,right=camera.rightWC;
    const view=this.view ??= {};
    Object.assign(view,{x:pos.x,y:pos.y,z:pos.z,dx:dir.x,dy:dir.y,dz:dir.z,ux:up.x,uy:up.y,uz:up.z,rx:right.x,ry:right.y,rz:right.z});
    // Cesium 2D is a north-up orthographic map: objects project by their map
    // coordinates against the frustum extents around the view centre, and the
    // map width stands in for the altitude every display policy keys on.
    view.map=Boolean(C.SceneMode) && scene.mode===C.SceneMode.SCENE2D;
    if(view.map){
      const frustum=camera.frustum,centre=scene.mapProjection.project(camera.positionCartographic,this.mapScratch ??= {x:0,y:0,z:0});
      view.cx=centre.x;view.cy=centre.y;view.mapWidth=frustum.right-frustum.left;view.mapHeight=frustum.top-frustum.bottom;
    }
    return view;
  }
  // Map coordinates of a displayed position; null off the ellipsoid.
  mapPoint(position) {
    const carto=this.C.Ellipsoid.WGS84.cartesianToCartographic(position,this.cartographicScratch ??= {longitude:0,latitude:0,height:0});
    return carto?this.viewer.scene.mapProjection.project(carto,this.projectedScratch ??= {x:0,y:0,z:0}):null;
  }
  updateLod(selectedId,now=performance.now(),{incremental=false,tracking=false,moving=false,budgetMs=2}={}) {
    this.modelsMoving=moving;
    const v=this.viewer,camera=v.camera;
    const began=performance.now();
    if(!incremental || !this.lodScan || this.lodScan.selectedId!==selectedId || this.lodScan.tracking!==tracking){
      const view=this.captureView(camera),width=v.canvas.clientWidth,screenHeight=v.canvas.clientHeight;
      const height=view.map?view.mapWidth:Math.max(0,camera.positionCartographic.height);
      // On the map the apparent size of an object is its size over the map
      // height; the same pixel formula holds with these stand-in optics.
      const tanHalf=view.map?view.mapHeight/(2*Math.max(1,view.mapWidth)):Math.tan(camera.frustum.fovy/2);
      Object.assign(view,{width,height:screenHeight,tanHalf,aspect:width/Math.max(1,screenHeight)});
      this.pointInterval=height>2000000?100:50;this.candidates.length=0;
      this.lodScan={iterator:this.items.values(),selectedId,tracking,view,width,screenHeight,fov:view.map?2*Math.atan(tanHalf):camera.frustum.fovy,cameraHeight:height,
        ranges:{aircraft:categoryRange('aircraft',height),satellite:categoryRange('satellite',height),
          uam:categoryRange('uam',height),drone:categoryRange('uam',height),bird:categoryRange('uam',height)},
        symbols:{aircraft:drawsSymbol('aircraft',height),satellite:drawsSymbol('satellite',height),
          uam:drawsSymbol('uam',height),drone:drawsSymbol('uam',height),bird:drawsSymbol('uam',height)}};
    } else this.captureView(camera);
    const C=this.C,scan=this.lodScan,{view,width,screenHeight,ranges}=scan;
    let checked=0;
    while(true){
      if(incremental && (checked++>=(moving?1200:4000) || (checked%128===0 && performance.now()-began>=budgetMs)))return;
      const next=scan.iterator.next();if(next.done)break;const item=next.value;
      const layer=this.layers[item.entity.kind];if(!layer.visible)continue;
      item.previousLod=item.lod;item.selected=item.entity.entity_id===selectedId;
      // Fresh sampled positions ensure hidden targets can re-enter the view.
      this.refreshPosition(item,now);item.projection ??= {};
      let projected;
      if(view.map){
        // One scale for the whole map: every object sits at the view's altitude.
        const point=this.mapPoint(item.position);
        projected=Boolean(point) && projectMap(point,view,item.projection);item.distance=view.mapWidth;
      } else {
        const dx=item.position.x-view.x,dy=item.position.y-view.y,dz=item.position.z-view.z;item.distance=Math.hypot(dx,dy,dz);
        projected=projectView(item.position,view,item.projection);
      }
      const visible=view.map?projected:(item.distance<=ranges[item.entity.kind] && projected && this.occluder.isPointVisible(item.position));
      // The selection is what the camera is anchored to, or what the operator
      // is reading about: a scan never culls it. Its view may be a few frames
      // old, and a pursued model would blink out for a whole scan at a time.
      if(!item.selected && !visible){
        item.lod='hidden';this.applyVisibility(item,item.selected);if(item.label){layer.labels.remove(item.label);item.label=null;}continue;
      }
      if(!projected){item.projection.x=width/2;item.projection.y=screenHeight/2;item.projection.depth=Math.max(1,item.distance);}
      const size=this.sizeOf(item.assetId,articulatedFlight(item.entity));
      item.lod=chooseLod({distance:item.distance,previous:item.previousLod,selected:item.selected,sizeM:size,
        viewportHeight:screenHeight,fov:scan.fov,symbol:scan.symbols[item.entity.kind]});
      if(item.lod==='model' && layer.showModels===false)item.lod='billboard';
      item.pixels=size*screenHeight/(2*Math.max(1,item.distance)*view.tanHalf);
      this.candidates.push(item);
    }
    this.lodScan=null;
    // Model/selection priorities matter. Do not sort thousands of indistinguishable
    // 3 px points by distance every scan; stable insertion order also limits shimmer.
    this.candidates.sort((a,b)=>Number(b.selected)-Number(a.selected) || Number(this.pilotOwned(b))-Number(this.pilotOwned(a)) || Number(b.lod==='model')-Number(a.lod==='model') || (a.lod==='model'?b.pixels-a.pixels:0));
    const cells=this.cells ??= (()=>{const uam=new Set();
      // Shared with uam on purpose: one screen cell, one mark, whichever of the
      // three low-flying kinds got there first.
      return {aircraft:new Set(),satellite:new Set(),uam,drone:uam,bird:uam};})();
    for(const set of Object.values(cells))set.clear();
    const labelBounds=this.labelBounds ??= [];labelBounds.length=0;this.frameItems.length=0;
    const nearPolicy=nearLabelPolicy(scan.cameraHeight,this.labelBand);
    this.labelBand=nearPolicy?.kind ?? 'off';
    let models=0,labels=0,nearLabels=0,automaticLabels=0;
    for(const item of this.candidates){
      if(this.items.get(item.entity.entity_id)!==item || !this.layers[item.entity.kind].visible)continue;
      const layer=this.layers[item.entity.kind],p=item.projection;
      // Past the model budget an aircraft steps down one tier, not all the way
      // to a dot. Before the glyph tier existed this was the cliff that made a
      // crowded sky look like confetti - and worse, it churned: an aircraft
      // dropped to a dot on one scan asked for its model back on the next.
      if(item.lod==='model' && !item.selected && models>=this.performance.maxModels)item.lod='billboard';
      const cell=screenCell(p.x,p.y,width);
      // Things sharing a screen cell are dropped: a thousand indistinguishable
      // marks in one cell is a smear, not information. A glyph is bigger than a
      // dot and so needs more room before the next one is worth drawing, which
      // is what keeps a crowded sky a scatter of shapes rather than a wall of
      // them. Batching means the ones that are drawn cost nothing extra.
      const crowded=item.entity.kind==='uam'?cells.uam.has(cell):item.lod==='billboard'?cells[item.entity.kind].has(glyphCell(p.x,p.y,width)):cells[item.entity.kind].has(cell);
      if(!item.selected && item.lod!=='model' && (crowded || this.frameItems.length>=8000))item.lod='hidden';
      if(item.lod!=='hidden'){
        cells[item.entity.kind].add(item.lod==='billboard' && item.entity.kind!=='uam'?glyphCell(p.x,p.y,width):cell);
        this.frameItems.push(item);item.point.position=item.position;
        if(item.lod==='model'){models++;item.lastModelUse=now;if(!item.model || item.failed)this.loadModel(item,item.selected);}
      }
      const onScreen=p.x>=0 && p.x<=width && p.y>=0 && p.y<=screenHeight && (view.map || this.occluder.isPointVisible(item.position));
      const uam=item.entity.kind==='uam';
      const automatic=this.pilotOwned(item) || (uam ? labels<120 && scan.cameraHeight<=400000 && item.distance<=Math.min(uamLabelRange(scan.cameraHeight),categoryRange('uam',scan.cameraHeight)) : !scan.tracking && nearPolicy && inLabelBand(item.entity.kind,nearPolicy.kind) && labels<nearPolicy.max && item.distance<=nearPolicy.range);
      // Most candidates never get a name. Do not format text and construct
      // collision rectangles for every distant dot on every orbit step.
      const labelsEnabled=this.pilotOwned(item)||layer.showLabels!==false||(item.entity.kind==='uam'&&layer.showStatus!==false);
      if(!labelsEnabled || item.lod==='hidden' || !onScreen || (!item.selected && (!automatic || (moving&&!item.label&&!uam)))){
        if(item.label){layer.labels.remove(item.label);item.label=null;}
        this.applyVisibility(item,item.selected);continue;
      }
      const small=!uam && !item.selected && item.lod!=='model';
      const fontSize=small?10:12,offset=small?8:10,text=this.labelText(item,layer);
      const lines=text.split('\n'),textWidth=Math.max(...lines.map(line=>line.length))*fontSize;
      const textHeight=fontSize*(1+(lines.length-1)*1.4);
      const modelLabel=item.lod==='model' && item.model && !item.failed;
      let offsetX=offset,offsetY=-offset;
      if(modelLabel){
        // A wing-span sphere greatly overstates vertical extent in rear views.
        // Keep the name near its anchor; the selected-label depth override below
        // preserves readability if the screen-space name overlaps the model.
        const pixels=Number.isFinite(item.pixels)?Math.max(0,item.pixels):0;
        offsetY=-Math.max(24,Math.min(48,16+pixels*.12));
        offsetY=Math.max(textHeight+12-p.y,offsetY);
        offsetX=Math.max(8-p.x,Math.min(offset,width-p.x-textWidth-16));
      }
      // Explicit left/bottom anchoring and conservative glyph-width bounds also
      // protect long names across adjacent cells. Selection reserves its space first.
      let box={left:p.x+offsetX-8,right:p.x+offsetX+textWidth+8,
        top:p.y+offsetY-textHeight-4,bottom:p.y+offsetY+4};
      let fits=box.left>=0 && box.right<=width && box.top>=0 && box.bottom<=screenHeight;
      let overlaps=labelBounds.some(b=>box.left<b.right+2 && box.right+2>b.left && box.top<b.bottom+2 && box.bottom+2>b.top);
      // Keep UAM names around crowded decks: try nearby slots before hiding.
      // Reuse the previous slot first to avoid swapping sides on every scan.
      if(uam && !item.selected){
        const slots=[[offsetX,offsetY],[-textWidth-16,offsetY],
          [offsetX,textHeight+12],[-textWidth-16,textHeight+12],
          [offsetX,offsetY-textHeight-12],[-textWidth-16,offsetY-textHeight-12],
          [offsetX,2*textHeight+24],[-textWidth-16,2*textHeight+24]];
        const order=[item.labelSlot??0,...slots.map((_,i)=>i)].filter((v,i,a)=>a.indexOf(v)===i);
        for(const slot of order){
          const [x,y]=slots[slot];
          const candidate={left:p.x+x-8,right:p.x+x+textWidth+8,top:p.y+y-textHeight-4,bottom:p.y+y+4};
          const inside=candidate.left>=0 && candidate.right<=width && candidate.top>=0 && candidate.bottom<=screenHeight;
          const collision=labelBounds.some(b=>candidate.left<b.right+2 && candidate.right+2>b.left && candidate.top<b.bottom+2 && candidate.bottom+2>b.top);
          if(inside&&!collision){box=candidate;offsetX=x;offsetY=y;fits=true;overlaps=false;item.labelSlot=slot;break;}
        }
      }
      const showLabel=Boolean(text) && labelsEnabled && item.lod!=='hidden' && onScreen && (item.selected || this.pilotOwned(item) || (automatic && fits && !overlaps));
      if(showLabel){
        labels++;if(small)nearLabels++;if(!item.selected)automaticLabels++;labelBounds.push(box);
        if(!item.label){item.label=layer.labels.add({id:item.entity.entity_id,position:item.position,text,
          font:small?'10px sans-serif':'12px sans-serif',fillColor:this.labelColour(item),showBackground:true,
          horizontalOrigin:C.HorizontalOrigin?.LEFT,verticalOrigin:C.VerticalOrigin?.BOTTOM,backgroundPadding:new C.Cartesian2(8,4),
          backgroundColor:C.Color.BLACK.withAlpha(small?.55:.7),pixelOffset:new C.Cartesian2(small?8:10,small?-8:-10)});
          this.startLabelFade(item,now);}
        else if(item.labelSmall!==small){item.label.font=small?'10px sans-serif':'12px sans-serif';
          item.label.backgroundColor=C.Color.BLACK.withAlpha((small?.55:.7)*(item.labelAlpha??1));item.label.pixelOffset=new C.Cartesian2(small?8:10,small?-8:-10);}
        item.labelRect={width:textWidth,height:textHeight};
        item.label.show=Boolean(text)&&!item.labelOccluded;
        item.labelSmall=small;
        if(this.pilotOwned(item))item.label.fillColor=this.labelColour(item).withAlpha(item.labelAlpha??1);
        if(item.label.text!==text)item.label.text=text;
        // UAM labels use whole-label occlusion after rendering, so buildings
        // never cut individual glyphs in half. Other traffic keeps its policy.
        item.label.disableDepthTestDistance=uam?Infinity:!modelLabel?0:item.selected?Infinity:MODEL_LABEL_DEPTH_M;
        item.label.pixelOffset=new C.Cartesian2(offsetX,offsetY);
      }
      else if(item.label){layer.labels.remove(item.label);item.label=null;}
      this.applyVisibility(item,item.selected);
    }
    // Ready slots must go to the largest approaching glyph, not catalogue order.
    // Otherwise an unrelated distant aircraft can occupy the only moving slot
    // while the deck immediately in front of the camera waits for a full scan.
    const warm=this.candidates.filter(item=>item.lod==='billboard' && item.pixels>=3 && (!item.model || item.failed)
      && this.layers[item.entity.kind].showModels!==false).sort((a,b)=>b.pixels-a.pixels||a.distance-b.distance);
    // Prepare the next close-up before it crosses the six-pixel model threshold.
    // The same load/GPU budget applies during camera movement, so approaching a
    // deck does not defer all aircraft until the camera comes to a full stop.
    for(const item of warm)this.loadModel(item);
    this.trimModels(now);
    Object.assign(this.stats,{visible:this.frameItems.length,candidates:this.candidates.length,models,labels,nearLabels,automaticLabels,labelBand:this.labelBand},this.modelStats());
    this.needsLod=false;
  }
  destroy(){this.manualTurnaround?.destroy();this.removeLabelOcclusion?.();this.chargingCables?.destroy();this.disposed=true;this.fadingLabels.clear();this.lodScan=null;for(const item of this.residentModels)this.releaseModel(item);this.frameItems.length=0;
    for(const entry of this.warmed?.values()??[])this.finishWarmAsset(entry,true);this.warmed?.clear();}
}
