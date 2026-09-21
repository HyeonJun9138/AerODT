import {buildElement,buildSvg} from './dom_builder.js';
import {CameraDetectionSession} from './camera_detection_session.js';
import {INTRUDERS} from './intruder_injection.js';
import {PerceptionTracks} from './camera_perception.js';
const VIEWS={front:['↑','전방'],left:['←','좌측'],right:['→','우측'],rear:['↓','후방'],down:['⊙','하방']};
const KINDS=new Set(['uam','aircraft','helicopter','drone']);
const LABELS={bird:'새',drone:'드론',airplane:'비행기',helicopter:'헬리콥터','fixed-wing drone':'고정익 드론'};
const AXES={forward:[1,0,0],up:[0,1,0]};

// The frame for the detector, as base64 JPEG, encoded off the main thread.
//
// `toDataURL` encodes synchronously and was costing 26 ms on every submit,
// five times a second, in the same thread that draws the map. `toBlob` hands
// the encode to the browser's worker pool and comes back when it is done.
export function encodeJpeg(canvas,quality=.82){
 return new Promise((resolve,reject)=>{
  const fromUrl=url=>{const data=String(url).split(',')[1];data?resolve(data):reject(new Error('empty frame'));};
  if(typeof canvas.toBlob!=='function'){try{fromUrl(canvas.toDataURL('image/jpeg',quality));}catch(error){reject(error);}return;}
  canvas.toBlob(blob=>{
   if(!blob){reject(new Error('empty frame'));return;}
   const reader=new FileReader();reader.onload=()=>fromUrl(reader.result);reader.onerror=()=>reject(reader.error??new Error('encode failed'));reader.readAsDataURL(blob);
  },'image/jpeg',quality);
 });
}

// Read the displayed visual pose, not a second copy of authoritative state.
// The visual that pose belongs to is read the same way: the scene is asked
// which file it draws this entity as and how big, once, and both travel on the
// frame. Answering either half again here is how the two came apart.
export function cameraFrame(globe,entity,expectedPlan){
 if(!entity)return null;
 if(entity.source==='replay'){
  const l=globe.flightLayer,m=l?.model;
  if(expectedPlan&&l?.plan!==expectedPlan)return null;
  if(!l?.sample?.position||!m?.ready||m.show===false||l.visible===false)return null;
  // One asset here: `asset()` merges the flight rig over the base, and the rig
  // is what was loaded and what was measured for the scale it was loaded at, so
  // the drawn model's own scale is already the number that belongs to its uri.
  const a=l.asset();
  return {matrix:m.modelMatrix,scale:m.scale??1,uri:a?.uri,profile:a?.cockpit??AXES,assetId:l.plan?.aircraft?.asset_id,entityId:entity.entity_id,radius:m.boundingSphere?.radius,stale:false};
 }
 const item=globe.items?.get(entity.entity_id);if(!item?.position)return null;
 const scene=globe.entityScene,asset=scene.assets.get(item.assetId);
 const matrix=scene.matrix(item);if(!matrix)return null;
 // Which file and how big are one answer, taken where the map takes it, and
 // carried on the frame together so the camera draws that file at that size.
 // The map's loaded model is not asked for the size: it keeps whatever it was
 // built at until it is rebuilt, and an entity is only rebuilt when its asset
 // id changes - so a source that changes under it leaves the older of the two
 // answers, which is how a rig came to be drawn at the base model's scale.
 const visual=scene.visualOf?.(item)??{uri:asset?.flight_visual?.uri??asset?.uri,scale:scene.scaleOf(item.assetId,Boolean(asset?.flight_visual))};
 return {matrix,scale:visual.scale,uri:visual.uri,profile:asset?.cockpit??AXES,assetId:item.assetId,entityId:entity.entity_id,radius:(item.model?.ready?item.model.boundingSphere?.radius:null)??asset?.size_m/2,
  stale:['stale','frozen','unavailable','invalid'].includes(item.entity.quality)};
}

export class AircraftCameraPanel {
 constructor({document=globalThis.document,workspace,globe,Camera,fetch=globalThis.fetch,now=()=>Date.now(),requestFrame=f=>requestAnimationFrame(f),cancelFrame=id=>cancelAnimationFrame(id),intruders=null,perception=null}={}){
  Object.assign(this,{document,workspace,globe,Camera,fetch,now,requestFrame,cancelFrame,intruders});this.mode='front';this.result=null;
  // Where the detector's boxes are in the world. Shared with the page, which
  // puts them into the snapshot for the map and the risk panel.
  this.perception=perception??new PerceptionTracks({now});
  this.session=new CameraDetectionSession({now,request:async(body,signal)=>{
   const response=await fetch('/api/camera/detect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
   if(!response.ok){let detail;try{const error=await response.json();detail=error.detail??error.message;}catch{}throw new Error(typeof detail==='string'?detail:`AI 연결 실패 (${response.status})`);}return response.json();
  },release:id=>fetch(`/api/camera/session/${encodeURIComponent(id)}`,{method:'DELETE'}),onStatus:text=>{if(this.aiStatus)this.aiStatus.textContent=text;},onResult:(result,frame)=>{this.result={result};this.paint();this.perceive(result,frame);}});
 }
 el(tag,props,...children){return buildElement(this.document,tag,props,...children);}
 // Which objects carry a camera at all, so the page can offer the button for
 // those and only those. A satellite has no cockpit to look out of.
 static supports(entity){return Boolean(entity&&KINDS.has(entity.kind));}
 get isOpen(){return Boolean(this.root);}
 select(entity,{selected=false,reopen=false}={}){
  if(!entity){if(this.entity)this.close();return;}
  if(!selected&&!reopen)return;
  if(!KINDS.has(entity.kind)){this.close();return;}
  const changed=entity.entity_id!==this.entity?.entity_id;
  this.entity=entity;this.replayPlan=entity.source==='replay'?this.globe.flightLayer?.plan:null;
  if(!this.root)this.build();else this.workspace.reveal(this.root);
  if(changed){this.releaseIntruders();this.releasePerception();this.mode='front';this.setAi(false);this.camera?.stop();this.result=null;this.cover.hidden=false;this.cover.textContent='카메라 준비 중';this.presentedFrame=this.camera?.frameNumber??0;this.lastStart=-Infinity;}
  this.name.textContent=entity.callsign?.trim()||entity.name||entity.entity_id;
  this.session.select(entity.entity_id,this.mode);this.updateControls();this.schedule();
 }
 releaseIntruders(){this.intruders?.clear();if(this.intruderStatus)this.intruderStatus.textContent='';}
 // The detector's answer for one image, placed from the pose that image was
 // rendered from, then reported so the risk model can predict from it.
 perceive(result,frame){
  if(!this.perception||!frame?.pose||!this.entity?.entity_id)return;
  this.perception.observe(result,frame.pose,this.entity.entity_id,result.captured_at??this.now());
  const stateTime=this.globe?.entityScene?.samples?.stateTime;
  void this.perception.publish(this.fetch,Number.isFinite(stateTime)?stateTime:this.now()/1000);
 }
 releasePerception(){this.perception?.clear();}
 observeReplay(entity){if(this.entity?.source==='replay'&&entity?.entity_id!==this.entity.entity_id)this.close();}
 build(){
  this.root=this.el('div',{class:'aircraft-camera-panel'});this.name=this.el('span',{class:'ac-name'});
  this.aiButton=this.el('button',{type:'button',class:'ac-ai','aria-label':'AI Model ON',onclick:()=>this.setAi(!this.session.enabled)});
  this.root.append(this.el('div',{class:'ac-heading'},this.name,this.aiButton));
  this.viewport=this.el('div',{class:'ac-viewport'});this.canvas=this.el('canvas',{width:576,height:288,'aria-label':'선택 기체의 시뮬레이션 카메라 영상'});
  this.raw=this.el('canvas',{width:576,height:288});this.cover=this.el('span',{class:'ac-cover',text:'카메라 준비 중'});
  this.viewport.append(this.canvas,this.cover);this.root.append(this.viewport);
  const directions=this.el('div',{class:'ac-directions','aria-label':'카메라 시야 선택'});this.buttons={};
  const icon=buildSvg(this.document,'svg',{viewBox:'0 0 40 40','aria-hidden':'true'},buildSvg(this.document,'path',{d:'M20 3 24 17 35 24 35 28 23 24 23 32 27 35 27 37 20 35 13 37 13 35 17 32 17 24 5 28 5 24 16 17Z',fill:'currentColor'}));
  directions.append(this.el('span',{class:'ac-aircraft'},icon));
  for(const [mode,[arrow,label]] of Object.entries(VIEWS)){
   const button=this.el('button',{type:'button',class:`ac-direction ac-${mode}`,'aria-label':`${label} 카메라`,title:`${label} 카메라`,onclick:()=>this.setDirection(mode)},this.el('span',{'aria-hidden':'true',text:arrow}),this.el('span',{text:label}));
   this.buttons[mode]=button;directions.append(button);
  }
  this.root.append(directions);
  // Put something in front of the aircraft on purpose. It crosses the view, the
  // detector gets a look at it, and the same object reaches the risk side - the
  // question being asked is what the two make of it, so it has to be one object.
  if(this.intruders){
   const row=this.el('div',{class:'ac-intruders','aria-label':'장애물 출현'});
   row.append(this.el('span',{class:'ac-intruder-label',text:'출현'}));
   for(const [kind,spec] of Object.entries(INTRUDERS))
    row.append(this.el('button',{type:'button',class:'ac-intruder','data-kind':kind,
     title:`${spec.label}가 카메라 앞을 가로질러 지나갑니다 · 약 ${spec.speed_mps} m/s · ${spec.ahead_m} m 앞`,
     onclick:()=>this.launchIntruder(kind)},`${spec.label} 출현`));
   this.intruderStatus=this.el('span',{class:'ac-intruder-status',text:''});
   row.append(this.intruderStatus);
   this.root.append(row);
   this.intruders.onChange=count=>{if(this.intruderStatus)this.intruderStatus.textContent=count?`통과 중 ${count}`:'';};
  }
  this.aiStatus=this.el('span',{text:'AI OFF'});this.videoStatus=this.el('span',{text:'시뮬레이션 카메라'});
  // Frame rate and cost of the camera itself, so a slow image is a number.
  this.perf=this.el('span',{class:'ac-perf',title:'카메라 프레임 속도 · 한 프레임의 평균 비용 (최근 최대) · 이 카메라가 실제로 차지한 메인 스레드 비율',text:''});
  this.root.append(this.el('div',{class:'ac-status','aria-live':'polite'},this.videoStatus,this.perf,this.aiStatus));
  this.entry=this.workspace.manage(this.root,{kind:'aircraft-camera',label:'기체 카메라',width:420,height:450,onClose:()=>this.close()});
  // One camera for the life of the page: closing the window only pauses it,
  // so opening it again does not create a second WebGL context and compile
  // every program from scratch. It draws into whichever canvas the window has.
  const onStatus=state=>{this.videoStatus.textContent=state.age==='NO VIDEO'?'영상 수신 불가':'시뮬레이션 카메라';if(state.age==='NO VIDEO'){this.cover.hidden=false;this.cover.textContent=state.text;}
   if(this.perf)this.perf.textContent=Number.isFinite(state.fps)?`${state.fps} fps · ${state.ms} ms${Number.isFinite(state.duty)?` · 스레드 ${state.duty}%`:''}${state.last>state.ms*2?` (최대 ${state.last})`:''}`:'';};
  if(this.camera&&typeof this.camera.attach==='function'){this.camera.attach(this.raw);this.camera.onStatus=onStatus;}
  else this.camera=new this.Camera(this.globe,this.raw,onStatus,{cleanFrame:true,hideOwn:true});
  this.presentedFrame=this.camera.frameNumber??0;
  this.updateControls();
 }
 updateControls(){
  if(!this.root)return;
  for(const [mode,button] of Object.entries(this.buttons))button.setAttribute('aria-pressed',String(mode===this.mode));
  this.aiButton.title='비행물체 YOLOv8m / ByteTrack';this.aiButton.setAttribute('aria-pressed',String(this.session.enabled));this.aiButton.textContent=this.session.enabled?'AI Model ON':'AI Model OFF';
  this.aiButton.setAttribute('aria-label',this.session.enabled?'AI Model OFF로 전환':'AI Model ON으로 전환');
 }
 setDirection(mode){if(!VIEWS[mode]||mode===this.mode)return;this.mode=mode;this.result=null;this.session.select(this.entity?.entity_id,mode);this.camera?.clear();this.presentedFrame=this.camera?.frameNumber??0;this.camera?.set({enabled:true,mode});if(this.cover){this.cover.hidden=false;this.cover.textContent='시야 전환 중';}this.updateControls();}
 // Launched around the aircraft this camera is mounted on, so it crosses this
 // view rather than somewhere else's.
 launchIntruder(kind){
  if(!this.intruders||!this.entity?.entity_id)return null;
  const track=this.intruders.launch(kind,this.entity.entity_id);
  if(track&&this.intruderStatus)this.intruderStatus.textContent=`통과 중 ${this.intruders.active}`;
  return track;
 }
 setAi(enabled){this.result=null;if(!enabled)this.releasePerception();this.session.setEnabled(enabled);this.updateControls();if(this.canvas)this.paint();}
 schedule(){if(this.frameHandle||!this.root)return;this.frameHandle=this.requestFrame(now=>{this.frameHandle=null;try{this.tick(now);}catch{if(this.cover){this.cover.hidden=false;this.cover.textContent='기체 시점 갱신 대기';}}finally{this.schedule();}});}
 tick(now){
  if(!this.root)return;
  const inactive=this.document.hidden||this.entry.minimized||this.entry.shell.hidden;
  if(inactive){if(!this.paused){this.paused=true;this.camera.stop();this.session.suspend();this.result=null;}return;}
  this.paused=false;this.session.checkAge();
  const frame=cameraFrame(this.globe,this.entity,this.replayPlan);
  if(!frame||frame.stale){
   if(!this.unavailable){this.camera.stop();this.session.suspend();this.result=null;}this.unavailable=true;
   this.cover.hidden=false;this.cover.textContent=frame?.stale?'기체 위치 수신 지연':'기체 시점 준비 중';return;
  }
  this.unavailable=false;
  if(!this.camera.enabled){if(now-(this.lastStart??-Infinity)<3000)return;this.lastStart=now;this.camera.set({enabled:true,mode:this.mode});}
  this.camera.update(frame,now);
  // Rendering completes outside this tick. Consume each completed frame once,
  // including frames produced between ticks, rather than testing synchronously.
  const serial=this.camera.frameNumber??0;
  if(serial>0&&serial!==(this.presentedFrame??0)){
   this.presentedFrame=serial;
   this.cover.hidden=true;this.paint();
   if(this.session.enabled&&!this.session.pending&&!this.encoding&&this.now()-this.session.last>=200){
    try{
     // `toBlob` copies the bitmap the moment it is called, so the live canvas
     // is encoded as it is now even though the render loop goes on drawing
     // into it. One encode in flight at a time; the session then allows one
     // request.
     this.encoding=true;
     const pose=this.camera.lastPose;
     encodeJpeg(this.raw,.82).then(image_base64=>{
      this.encoding=false;if(!this.root||!this.session.enabled)return;
      void this.session.submit({width:576,height:288,image_base64,pose});
     }).catch(()=>{this.encoding=false;if(this.aiStatus)this.aiStatus.textContent='영상 프레임을 읽을 수 없습니다';});
    }catch{this.encoding=false;this.aiStatus.textContent='영상 프레임을 읽을 수 없습니다';}
   }
  }else if(this.result&&this.now()-this.result.result.captured_at>1000){this.result=null;this.paint();}
 }
 // The picture is always the live frame. The detector answers for a frame
 // submitted some hundreds of milliseconds earlier; showing *that* frame while
 // an answer was fresh and the live one once it aged out made the picture step
 // back in time on every answer and jump forward again a second later. The
 // boxes are drawn over the live frame instead — a little behind the motion,
 // as every live overlay is — and time only runs forward.
 paint(){
  const ctx=this.canvas?.getContext?.('2d');if(!ctx)return;
  if(this.result&&this.now()-this.result.result.captured_at>1000)this.result=null;
  const result=this.session.enabled?this.result:null;
  ctx.drawImage(this.raw,0,0,576,288);
  if(!result)return;
  ctx.lineWidth=1.5;ctx.font='12px "Segoe UI", sans-serif';
  for(const d of result.result.detections){
   if(!Array.isArray(d.box)||d.box.length!==4||!d.box.every(Number.isFinite)||!Number.isFinite(d.confidence))continue;
   const [x1,y1,x2,y2]=d.box.map((v,i)=>Math.max(0,Math.min(i%2?288:576,v)));if(x2<=x1||y2<=y1)continue;
   const name=String(d.class_name??'').toLowerCase();if(name==='background')continue;
   const label=`${LABELS[name]??d.class_name} ${d.track_id==null?'':`#${d.track_id} `}${Math.round(d.confidence*100)}%`;
   ctx.strokeStyle=name==='bird'?'#f0ce85':'#87d9ce';ctx.strokeRect(x1,y1,x2-x1,y2-y1);
   const width=ctx.measureText(label).width+10,x=Math.min(x1,576-width),y=Math.max(0,y1-20);
   ctx.fillStyle='#0b1826dd';ctx.fillRect(x,y,width,19);ctx.fillStyle='#e5f4f5';ctx.fillText(label,x+5,y+14);
  }
 }
 close(){
  this.cancelFrame(this.frameHandle);this.frameHandle=null;this.camera?.stop();this.session.setEnabled(false);this.session.suspend();this.result=null;
  // A crossing exists to be watched through this camera. With the camera shut
  // there is nobody watching, and an injected object left in the snapshot would
  // go on showing up on the map and in the risk panel as unexplained traffic.
  this.releaseIntruders();this.releasePerception();
  if(this.root){this.workspace.release(this.root);this.root.remove();}this.root=null;this.entity=null;this.entry=null;this.lastStart=-Infinity;
 }
 destroy(){this.close();this.camera?.destroy();this.camera=null;this.session.destroy();}
}
