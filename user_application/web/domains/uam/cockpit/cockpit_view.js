import {manualArrivalHolding} from '../operations/psu_pilot_guidance.js?v=20260921-arrival2';
import {manualFlightTiming} from './cockpit_flight_progress.js';
import {observedCockpit} from './cockpit_observed.js?v=20260917-multi-mfd';
import {CockpitConsole,consoleSurface,CONSOLE_WIDTH,CONSOLE_HEIGHT,CONSOLE_FOCUS_WIDTH,CONSOLE_FOCUS_HEIGHT} from './cockpit_console.js?v=20260921-repeat-flight';
import {surfaceChart} from './cockpit_surface.js';
import {SCREEN_WIDTH,SCREEN_HEIGHT} from './cockpit_instruments.js?v=20260914-cabin';
import {cockpitInstrumentState} from './cockpit_state.js?v=20260914-cabin';
import {CockpitPanel} from './cockpit_panel.js?v=20260921-lower';
// Current observed contacts only; prediction paths belong to the radar panel.
export function navTraffic(items, ownId){
 return [...(items?.values()??[])].map(item=>item.entity).filter(e=>e&&e.entity_id!==ownId&&
  ['uam','aircraft','helicopter','drone'].includes(e.kind)&&Number.isFinite(e.latitude_deg)&&Number.isFinite(e.longitude_deg));
}
// Application composition only: all pose and projection inputs come from the
// visualization layer. Optional external rendering is owned by visualization.
export class CockpitView {
 constructor({globe,Camera,Throttle,Stick,screenCorners,screenTransform,document=globalThis.document,readMission=()=>null,readClock=()=>null,readControls=()=>null,readManual=()=>null,readPsu=()=>null,onControl=()=>{},onGround=()=>{},onPsu=()=>{},onViewChange=()=>{}}){
  Object.assign(this,{globe,screenCorners,screenTransform,document,readMission,readClock,onViewChange});
  this.camera=new Camera(globe.C,globe.viewer);this.panel=new CockpitPanel({document,onViewpoint:id=>this.setCabinView(id),onOccupants:shown=>this.showOccupants(shown),onCameraChange:value=>this.changeExternalCamera(value),onPlayback:action=>this.playbackAction(action),onScreenFocus:()=>this.console?.setFocused(false)});
  this.readControls=readControls;this.readManual=readManual;this.readPsu=readPsu;this.onControl=onControl;
  // The thrust lever lives in the cabin, not on a page. It draws whatever the
  // throttle already is -- keyboard, stick or this hand -- so the three agree.
  this.throttle3d=Throttle?new Throttle(globe.C,globe.viewer.scene):null;
  this.stick3d=Stick?new Stick(globe.C,globe.viewer.scene):null;
  this.console=new CockpitConsole({document:this.document,onControl,onGround,onPsu:kind=>onPsu(kind),onFocus:()=>this.panel.setScreenFocus(null)});
  this.panel.root.append(this.console.root);
  this.panel.navAutopilot?.append(this.console.autopilotButton,this.console.holdAltitudeButton,this.console.holdPositionButton);
  this.panel.dockBody.append(this.console.controlsRoot);
  this.panel.root.classList.add('cockpit-projected');document.body.append(this.panel.root,this.panel.toolbar);
  for(const screen of Object.values(this.panel.screens))Object.assign(screen.style,{position:'absolute',width:`${SCREEN_WIDTH}px`,height:`${SCREEN_HEIGHT}px`,left:'0',top:'0',transformOrigin:'0 0',pointerEvents:'auto'});
  this.button=document.getElementById('cockpit-view');this.button.onclick=()=>this.active?this.exit(true):this.enter();
  this.down=e=>{
   if(!this.active||e.button!==0)return;
   const box=globe.viewer.canvas.getBoundingClientRect?.()??{left:0,top:0};
   const at={x:e.clientX-box.left,y:e.clientY-box.top};
   const controls=this.manualControls();
   // Only a hand that is allowed to fly it may move it. With a stick attached
   // its own lever is the authority, and this one only reports.
   if(controls?.enabled&&controls.source!=='joystick'&&this.throttle3d?.grab(at,controls.throttle)){
    globe.viewer.canvas.setPointerCapture?.(e.pointerId);this.lever={id:e.pointerId,box};return;
   }
   if(controls?.enabled&&controls.source!=='joystick'&&this.stick3d?.grab(at,controls)){
    if(controls.source!=='screen')this.onControl?.('source','screen');
    globe.viewer.canvas.setPointerCapture?.(e.pointerId);this.stickHand={id:e.pointerId,box};return;
   }
   this.drag={id:e.pointerId,x:e.clientX,y:e.clientY};globe.viewer.canvas.setPointerCapture?.(e.pointerId);
  };
  this.move=e=>{
   if(!this.active)return;
   if(this.stickHand?.id===e.pointerId){const value=this.stick3d.move({x:e.clientX-this.stickHand.box.left,y:e.clientY-this.stickHand.box.top});if(value)this.onControl?.('stick',value);return;}
   if(this.lever?.id===e.pointerId){
    const value=this.throttle3d.move({x:e.clientX-this.lever.box.left,y:e.clientY-this.lever.box.top});
    if(value!==null)this.onControl?.('throttle',value);
    return;
   }
   if(this.drag?.id===e.pointerId){this.camera.look(e.clientX-this.drag.x,e.clientY-this.drag.y);this.drag.x=e.clientX;this.drag.y=e.clientY;}
  };
  this.up=()=>{if(this.stickHand)this.onControl?.('stick',{x:0,y:0});this.stickHand=null;this.stick3d?.release();this.drag=null;this.lever=null;this.throttle3d?.release();};
  const canvas=globe.viewer.canvas;canvas.addEventListener('pointerdown',this.down);canvas.addEventListener('pointermove',this.move);canvas.addEventListener('pointerup',this.up);canvas.addEventListener('pointercancel',this.up);canvas.addEventListener('lostpointercapture',this.up);
  this.removePost=globe.viewer.scene.postRender.addEventListener(()=>this.project());
 }
 setCabinView(id){
  if(!this.camera.setViewpoint(id))return;
  this.hideScreens();this.panel.setViewpointLabel(id);this.showOccupants(this.panel.occupantsShown);
 }
 showOccupants(shown){
  const C=this.globe.C;if(!this.model?.ready||this.model.isDestroyed?.()||!this.profile?.occupant_nodes?.length)return;
  const ownSeat=this.profile.viewpoints?.find(v=>v.id===this.camera.viewpoint)?.occupant_node;
  this.model.aerodtOwnSeat=this.active?ownSeat:null;this.model.aerodtPreview=shown;
  for(const [i,name] of this.profile.occupant_nodes.entries()){
   const node=this.model.getNode(name);if(!node)continue;
   const visible=(shown||(this.model.aerodtCabinSeats??[]).includes(i))&&name!==ownSeat;
   if(visible){const scale=1/(this.profile.occupant_default_scale??.0001);node.matrix=C.Matrix4.multiplyByScale(node.originalMatrix,new C.Cartesian3(scale,scale,scale),new C.Matrix4());node.aerodtSized=true;}
   node.show=visible;
  }
 }
 prepareCabinModels(now){
  if(now-(this.lastCabinPrepare??-Infinity)<500)return;this.lastCabinPrepare=now;
  this.preparedCabins??=new WeakSet();
  const prepare=(model,profile)=>{
   if(!model?.ready||!model.getNode||model.isDestroyed?.()||this.preparedCabins.has(model)||!profile?.occupant_nodes)return;
   // Default preview is off. Avoid issuing tiny occupant draw calls on every aircraft.
   if(!model.aerodtCabinSeats&&(model!==this.model||!this.panel.occupantsShown))for(const name of profile.occupant_nodes){const n=model.getNode(name);if(n)n.show=false;}
   this.preparedCabins.add(model);
  };
  for(const item of this.globe.items.values())prepare(item.model,this.globe.entityScene.assets.get(item.assetId)?.cockpit);
  const l=this.globe.flightLayer;if(l?.model)prepare(l.model,l.asset?.()?.cockpit);
 }
 async changeExternalCamera(value){
  if(!value.enabled){this.externalCamera?.stop();return;}
  try{
   if(!this.externalCamera){
    this.externalModule??=import('/visualization/airframe_camera.js?v=20260914-cabin');
    const {AirframeCamera}=await this.externalModule;
    if(!this.active||!this.panel.cameraEnabled)return;
    this.externalCamera??=new AirframeCamera(this.globe,this.panel.cameraCanvas,state=>this.panel.setCameraStatus(state),{cockpit:true,cleanFrame:true});
   }
   this.externalCamera.set({enabled:this.panel.cameraEnabled,mode:this.panel.cameraMode});
  }catch{this.panel.setCameraStatus({text:'카메라 모듈을 불러오지 못했습니다',age:'NO VIDEO'});}
 }
 // A control lease belongs to an aircraft, not to a camera mode.
 dockControls(){
  const controls=this.readControls?.();
  if(!controls)return null;
  const owner=controls.entity_id??'preview:selected-flight';
  const viewed=this.active?(this.single?'preview:selected-flight':this.entityId):this.globe.selected;
  return {...controls,viewingOther:Boolean(viewed&&viewed!==owner)};
 }
 manualControls(){
  const controls=this.readControls?.();
  if(!controls)return null;
  if(!this.active)return controls;
  const owner=controls.entity_id??'preview:selected-flight';
  return owner===(this.single?'preview:selected-flight':this.entityId)?controls:null;
 }
 manualFrame(){
  const frame=this.readManual?.();
  return this.manualControls()&&frame?.sample&&frame?.plan?frame:null;
 }
 get active(){return this.camera.active;}
 get entityId(){return this.camera.entityId;}
 look(dx,dy){this.camera.look(dx,dy);}
 resetLook(){this.camera.resetLook();}
 zoom(delta,mode){this.camera.zoom(delta,mode);}
 usable(item){
  const g=this.globe,asset=g.entityScene.assets.get(item?.assetId),e=item?.entity;
  return Boolean(asset?.cockpit&&item?.model?.ready===true&&item.model.show!==false&&!item.failed&&
   (!asset.flight_visual||e.source==='scenario'||e.kind==='uam'&&e.source==='physical_uam')&&
   g.entityScene.layers[e.kind]?.visible!==false&&g.entityScene.layers[e.kind]?.showModels!==false);
 }
 playbackSources(){
  const d=this.document,manualFleet=Boolean(this.readControls?.()?.entity_id?.startsWith('scenario:'));
  const single=!manualFleet&&(this.single||(!this.active&&!this.globe.items.get(this.globe.selected)&&this.singleUsable()));
  const playing=single?d.getElementById('plan-play')?.getAttribute('aria-pressed')==='true':d.getElementById('scenario-console')?.getAttribute('data-state')==='playing';
  return {playing,manualFleet,button:d.getElementById(single?'plan-play':playing?'scenario-pause':'scenario-play'),
    rate:d.getElementById(single?'plan-rate':'scenario-mini-speed'),clock:d.getElementById(single?'plan-clock':'scenario-clock')};
 }
 playbackAction(action){
  const source=this.playbackSources(),button=action==='toggle'?source.button:action==='rate'?source.rate:null;
  const manual=this.readControls?.();
  if((this.active||this.panel.dockAvailable)&&(!manual||(source.manualFleet&&action==='toggle'))&&button&&!button.disabled)button.click();
 }
 syncPlayback(now){
  if(!this.panel.setPlayback||!this.document.getElementById||now-(this.lastPlaybackPaint??-Infinity)<100)return;
  this.lastPlaybackPaint=now;const s=this.playbackSources();
  this.panel.setPlayback({enabled:Boolean(s.clock&&s.button),time:s.clock?.textContent??'—',playing:s.playing,
    speed:s.manualFleet?'×1 · 수동 고정':s.rate?.textContent??'×1',manualFleet:s.manualFleet,canToggle:Boolean(s.button&&!s.button.disabled),canRate:!s.manualFleet&&Boolean(s.rate&&!s.rate.disabled)});
 }
 hideNameplates(){
  const labels=this.globe.entityScene.layers.uam?.labels;
  this.nameplateState={labels,shown:labels?.show,flightHidden:this.globe.flightLayer?.cockpitLabelsHidden};
  // Collection visibility survives per-entity show writes and LOD recreation.
  if(labels)labels.show=false;
  this.globe.flightLayer?.setCockpitLabelsHidden?.(true);
 }
 restoreNameplates(){
  const saved=this.nameplateState;if(!saved)return;
  if(saved.labels&&!saved.labels.isDestroyed?.())saved.labels.show=saved.shown;
  this.globe.flightLayer?.setCockpitLabelsHidden?.(saved.flightHidden??false);
  this.nameplateState=null;
 }
 singleUsable(){
  const l=this.globe.flightLayer;
  return Boolean(l?.plan&&l.sample?.position&&l.visible!==false&&l.display?.aircraft!==false&&l.model?.ready===true&&l.model.show!==false&&!l.modelFailed&&l.asset()?.cockpit);
 }
 enterSingle(){
  const g=this.globe,l=g.flightLayer;
  if(this.active&&this.single){this.exit(true);return true;}
  if(!this.singleUsable()||g.entryActive||g.transitioning||g.sceneMode==='2d')return false;
  g.stopTracking();
  const profile=l.asset().cockpit;
  if(!this.camera.enter({entityId:'preview:selected-flight',profile}))return false;
  this.button.disabled=false;this.button.textContent='외부 추적';this.button.setAttribute('aria-pressed','true');
  this.single=true;this.singlePlan=l.plan;this.profile=profile;this.model=l.model;this.assetId=l.plan.aircraft?.asset_id;
  this.hideNameplates();this.panel.open();this.hideScreens();this.panel.setCabin?.(this.profile);this.showOccupants(false);this.lastState=-Infinity;this.document.body.classList.add('cockpit-active');this.updateSingle(performance.now());if(this.active)this.onViewChange?.();return this.active;
 }
 updateSingle(now){
  const g=this.globe,l=g.flightLayer;
  if(!this.singleUsable()||l.plan!==this.singlePlan||l.model!==this.model||l.plan.aircraft?.asset_id!==this.assetId){this.exit();return;}
  this.matrix=l.model.modelMatrix;this.scale=l.model.scale??1;
  if(!this.camera.update({matrix:this.matrix,scale:this.scale,epoch:this.singlePlan})){this.exit();return;}
  this.updateHardware();
  const s=l.sample,p=s.position;
  this.console?.update({controls:s.manual?this.manualControls():null,dockControls:this.dockControls(),ground:s.ground_handling,telemetry:s,chart:this.lastChart,psu:this.manualControls()?this.readPsu?.():null});
  if(now>=this.lastState&&now-this.lastState<100&&s.time_s>=this.lastReplayTime)return;
  this.lastState=now;this.lastReplayTime=s.time_s;
  this.paintManual(s,l.plan,now,'preview:selected-flight');
 }
 paintManual(s,plan,now,id){
  if(this.lastManualId===id&&this.lastManualPlan===plan&&now>=this.lastManualPaint&&now-this.lastManualPaint<100&&s.time_s>=this.lastManualTime)return;
  this.lastManualId=id;this.lastManualPlan=plan;this.lastManualPaint=now;this.lastManualTime=s.time_s;
  const g=this.globe,p=s.position,psu=s.manual&&this.manualControls()?this.readPsu?.():null;
  this.panel.update({entity:{...s,entity_id:id,kind:'uam',
    orientation_source:Number.isFinite(s.pitch_deg)&&Number.isFinite(s.roll_deg)?'attitude':'ground_track',
    latitude_deg:p.latitude,longitude_deg:p.longitude,altitude_m:p.altitude_m,recorded_speed_mps:s.speed_mps,airborne:typeof s.airborne==='boolean'?s.airborne:s.kind==='air'?true:undefined},
   telemetry:{rotor_radps:s.rotor_radps,tilt_deg:s.tilt_deg,battery_soc_pct:s.battery_pct,mode:s.mode,flight_phase:s.stage_label??s.stage},
   mission:{origin:plan.departure?.name||plan.departure?.vertiport,origin_id:plan.departure?.vertiport,origin_name:g.vertiportLayer?.records?.get(plan.departure?.vertiport)?.name||plan.departure?.name,
     timing:manualFlightTiming({entityId:id,detail:this.readMission?.(id),psu,plan,sample:s}),
     holding:Boolean(manualArrivalHolding(psu)||s.hold?.mode==='position'),
     surface:(this.lastChart=surfaceChart(g.vertiportLayer?.records,{latitude_deg:p.latitude,longitude_deg:p.longitude,stage:s.stage,airborne:s.airborne,manual:s.manual},plan,null,psu)),destination:plan.arrival?.name||plan.arrival?.vertiport,destination_id:plan.arrival?.vertiport,destination_name:g.vertiportLayer?.records?.get(plan.arrival?.vertiport)?.name||plan.arrival?.name,phase:s.stage,route_points:(plan.legs??[]).flatMap(leg=>(leg.path??[]).map(p=>({longitude_deg:p[0],latitude_deg:p[1]})))},
   stateTime:s.time_s,epoch:plan,stale:false,nearby:navTraffic(g.items,id)},now);
 }
 enter(){
  const g=this.globe,item=g.items.get(g.selected),profile=g.entityScene.assets.get(item?.assetId)?.cockpit;
  if(!this.usable(item))return this.enterSingle();
  if(g.entryActive||g.transitioning||g.sceneMode==='2d')return false;
  g.stopTracking();g.detailId=null;
  if(!this.camera.enter({entityId:g.selected,profile}))return false;
  this.profile=profile;this.assetId=item.assetId;this.model=item.model;this.continuity=item.entity.continuity_id;this.hideNameplates();this.panel.open();this.hideScreens();this.panel.setCabin?.(this.profile);this.showOccupants(false);this.document.body.classList.add('cockpit-active');this.button.textContent='외부 추적';
  this.button.setAttribute('aria-pressed','true');this.update(performance.now());if(this.active)this.onViewChange?.();return this.active;
 }
 update(now){
  const controls=this.manualControls();
  const dockAvailable=Boolean(this.readControls?.()||this.globe.items.get(this.globe.selected)?.entity?.kind==='uam'||this.singleUsable());
  this.panel.setDockAvailable?.(dockAvailable);
  this.console?.updateControls?.(this.dockControls());this.panel.setManualMode?.(Boolean(this.readControls?.()));
  this.prepareCabinModels(now);
  if(this.active||dockAvailable)this.syncPlayback(now);
  if(this.single&&this.active){this.updateSingle(now);return;}
  const g=this.globe,item=g.items.get(this.entityId),selected=g.items.get(g.selected);
  if(!this.active){if(this.panel.active)this.exit();this.button.disabled=(!this.usable(selected)&&!this.singleUsable())||g.sceneMode==='2d';return;}
  if(!this.usable(item)||item.assetId!==this.assetId||item.model!==this.model||g.entityScene.assets.get(item.assetId)?.cockpit!==this.profile||g.selected!==this.entityId||item.entity.continuity_id!==this.continuity||g.entityScene.layers[item.entity.kind]?.visible===false||g.entityScene.layers[item.entity.kind]?.showModels===false){this.exit();return;}
  g.entityScene.refreshPosition(item,now);this.matrix=g.entityScene.matrix(item);this.scale=item.model.scale??1;
  if(!this.camera.update({matrix:this.matrix,scale:this.scale,now,epoch:g.entityScene.samples.epoch})){this.exit();return;}
  const manual=this.manualFrame();
  if(manual){
   this.updateHardware(controls);
   this.console?.update({controls,dockControls:this.dockControls(),ground:manual.sample.ground_handling,telemetry:manual.sample,chart:this.lastChart,psu:this.manualControls()?this.readPsu?.():null});
   this.paintManual(manual.sample,manual.plan,now,this.entityId);return;
  }
  const observed=observedCockpit(item.entity,g.entityScene.samples.telemetryAt(this.entityId,g.entityScene.samples.renderTime(this.entityId),{}),this.readMission(this.entityId));
  this.updateHardware(observed.controls);
  this.console?.update({controls:null,dockControls:this.dockControls(),ground:observed.ground,telemetry:observed.telemetry,chart:this.lastChart,stale:item.entity.stale===true||item.entity.quality==='stale',psu:this.manualControls()?this.readPsu?.():null});
  if(now-(this.lastState??-Infinity)<100)return;this.lastState=now;
  const samples=g.entityScene.samples,time=samples.renderTime(this.entityId),t=samples.telemetryAt(this.entityId,time,{}),entity={...item.entity};
  const heading=samples.headingAt(this.entityId,time),display={...t,heading_deg:heading};
  const xyz=samples.positionAt?.(this.entityId,time);
  if(xyz?.every(Number.isFinite)){
   const C=g.C,carto=C.Cartographic.fromCartesian(C.Cartesian3.fromArray(xyz));
   if(carto)Object.assign(display,{latitude_deg:carto.latitude*180/Math.PI,longitude_deg:carto.longitude*180/Math.PI,altitude_m:carto.height});
  }
  const instrumentState=cockpitInstrumentState({entity,display,stateTime:time,epoch:samples.epoch,
   missionDetail:this.readMission(this.entityId),clock:this.readClock?.(this.entityId),stale:entity.stale===true,
   nearby:navTraffic(g.items,this.entityId),
   resolveWaypoint:id=>{const p=g.routeLayer?.placed?.get(id);return p?{latitude_deg:p.latitude,longitude_deg:p.longitude,name:p.name??id}:null;}});
  this.lastStale=instrumentState.stale;
  instrumentState.mission.surface=this.lastChart=surfaceChart(g.vertiportLayer?.records,instrumentState.entity,null,this.readMission(this.entityId));
  instrumentState.mission.destination_name=g.vertiportLayer?.records?.get(instrumentState.mission.destination_id)?.name||instrumentState.mission.destination_name;
  instrumentState.mission.origin_name=g.vertiportLayer?.records?.get(instrumentState.mission.origin_id)?.name||instrumentState.mission.origin_name;
  this.panel.update(instrumentState,now);
 }
 // The screens have nowhere to be until the first projection. Left as they
 // are, opening the panel paints them at their own layout size across the
 // corner of the map for the frame before the postRender that places them —
 // which is why only the very first entry shows it: after that they still
 // carry the matrix the last one left on them. `project` shows them again.
 hideScreens(){this.revealStart=null;this.reduceMotion=this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;this.stick3d?.hide();this.throttle3d?.hide();if(this.console)this.console.root.hidden=true;this.lastChart=null;this.lastStale=false;for(const node of Object.values(this.panel.screens??{}))if(node)node.hidden=true;}
 updateHardware(observed=null){
  // Scene primitives must be moved before draw, alongside the cabin camera.
  // Updating them in postRender leaves them a frame behind a climbing aircraft.
  // The lever is placed from the cabin's own frame, so it rides the aircraft
  // the same way the screens do and needs no separate anchor.
  const held=observed??this.manualControls();
  this.panel.setControlInputs?.(this.manualControls());
  this.throttle3d?.update({matrix:this.matrix,scale:this.scale,profile:this.profile,
   throttle:held?.throttle,visible:Boolean(held)&&!this.console?.focused&&!this.camera.viewpoint?.startsWith('seat_')});
  this.stick3d?.update({matrix:this.matrix,scale:this.scale,profile:this.profile,controls:held,visible:Boolean(held)&&!this.console?.focused&&!this.camera.viewpoint?.startsWith('seat_')});
 }
 // Start at the first valid projection, not panel.open(): slow model loading
 // must not consume the fade before the instruments reach their cabin surface.
 revealScreen(node,now){
  this.revealStart??=now;
  const t=this.reduceMotion?1:Math.max(0,Math.min(1,(now-this.revealStart)/600));
  const opacity=t*t*(3-2*t);
  node.style.opacity=String(opacity);node.inert=t<1;node.style.pointerEvents=t<1||node===this.console?.root?'none':'auto';
  if(t<1)this.globe.viewer.scene.requestRender?.();
 }
 project(now=performance.now()){
  if(!this.active||!this.matrix){this.stick3d?.hide();this.throttle3d?.hide();return;}
  if(this.externalCamera?.enabled)this.externalCamera.update({matrix:this.matrix,scale:this.scale,profile:this.profile,assetId:this.assetId,entityId:this.entityId,radius:this.model?.boundingSphere?.radius,stale:this.globe.items.get(this.entityId)?.entity?.quality==='stale'},performance.now());
  const g=this.globe,C=g.C,v=g.viewer,cam=v.camera,offset=v.canvas.getBoundingClientRect();
  const world=p=>C.Matrix4.multiplyByPoint(this.matrix,new C.Cartesian3(p[0]*this.scale,-p[2]*this.scale,p[1]*this.scale),new C.Cartesian3());
  for(const screen of [...this.profile.screens,...(consoleSurface(this.profile)?[consoleSurface(this.profile)]:[])]){
   const isConsole=screen.id==='console',node=isConsole?this.console?.root:this.panel.screens[screen.id];if(!node)continue;
   const focused=isConsole?this.console.focused:this.panel.focusScreen===screen.id;
   const width=isConsole?(focused?CONSOLE_FOCUS_WIDTH:CONSOLE_WIDTH):SCREEN_WIDTH,height=isConsole?(focused?CONSOLE_FOCUS_HEIGHT:CONSOLE_HEIGHT):SCREEN_HEIGHT;
   node.style.zIndex=focused?'3':'0';
   if(focused){
    const dashboard=this.document.getElementById?.('aircraft-dashboard');
    const shelf=!dashboard?.hidden?dashboard?.getBoundingClientRect?.():null;
    const top=offset.top+16,bottom=Math.min(offset.top+offset.height-16,shelf?.height>0?shelf.top-16:Infinity);
    const room=Math.max(100,bottom-top),scale=Math.max(.2,Math.min(1.4,(offset.width-32)/width,room/height));
    this.revealScreen(node,now);node.hidden=false;node.style.transform=`translate(${offset.left+(offset.width-width*scale)/2}px,${top+(room-height*scale)/2}px) scale(${scale})`;
    continue;
   }
   // CSS instrument surfaces have no scene depth: never draw them through seats.
   if(this.camera.viewpoint?.startsWith('seat_')){node.hidden=true;continue;}
   const corners=(this.screenCorners(screen)??[]).map(world);let valid=corners.length===4;
   for(const p of corners)if(C.Cartesian3.dot(C.Cartesian3.subtract(p,cam.positionWC,new C.Cartesian3()),cam.directionWC)<=cam.frustum.near+.005)valid=false;
   if(valid){const normal=C.Cartesian3.cross(C.Cartesian3.subtract(corners[1],corners[0],new C.Cartesian3()),C.Cartesian3.subtract(corners[0],corners[3],new C.Cartesian3()),new C.Cartesian3());if(C.Cartesian3.dot(normal,C.Cartesian3.subtract(cam.positionWC,corners[0],new C.Cartesian3()))<=0)valid=false;}
   const points=valid?corners.map(p=>C.SceneTransforms.worldToWindowCoordinates(v.scene,p)):[];
   const matrix=points.length===4&&points.every(Boolean)?this.screenTransform(points.map(p=>[p.x+offset.left,p.y+offset.top]),width,height):null;
   node.hidden=!matrix;if(matrix){this.revealScreen(node,now);node.style.transform=`matrix3d(${matrix.join(',')})`;}
  }
 }
 // Leaving to look at this same aircraft keeps the camera where the cockpit had
 // it, so the view leaves from the aircraft. An exit nobody asked for -- the
 // model gone, the flight over -- still puts the camera back where the pilot
 // was, because there is nothing left to look at where it is standing.
 exit(follow=false,keepPose=follow){
  this.hideScreens();this.console?.close();this.showOccupants(false);if(this.model)this.model.aerodtOwnSeat=null;const id=this.entityId,single=this.single;this.single=false;this.singlePlan=null;this.camera.exit(keepPose);this.restoreNameplates();if(this.drag){try{this.globe.viewer.canvas.releasePointerCapture?.(this.drag.id);}catch{}}this.up?.();this.throttle3d?.remove();this.stick3d?.remove();this.lastState=-Infinity;this.panel.close();this.document.body.classList.remove('cockpit-active');
  this.button.textContent='조종석';this.button.setAttribute('aria-pressed','false');
  const item=this.globe.items.get(id);if(item)this.globe.entityScene.applyVisibility(item,true);
  if(follow&&single&&this.globe.flightLayer?.sample){this.globe.flyToFlight(this.globe.flightLayer.sample);this.globe.followFlight(this.globe.flightLayer.sample);}
  else if(follow&&item)this.globe.focus(true,undefined,{departure:true});
  if(follow)this.onViewChange?.();
 }
 destroy(){this.exit();this.externalCamera?.destroy();this.removePost?.();const c=this.globe.viewer.canvas;for(const [k,f] of [['pointerdown',this.down],['pointermove',this.move],['pointerup',this.up],['pointercancel',this.up],['lostpointercapture',this.up]])c.removeEventListener(k,f);this.button.onclick=null;this.stick3d?.destroy();this.throttle3d?.destroy();this.console?.destroy();this.panel.destroy();this.camera.destroy();}
}
