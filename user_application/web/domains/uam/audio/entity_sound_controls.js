// Application-side adaptation of the displayed object; never write back into
// the live entity or display sample buffers.
export function selectedSoundSample(globe){
  if(!globe||globe.entryActive||globe.sceneMode==='2d')return null;
  const item=globe.items?.get(globe.cockpit?.active?globe.cockpit.entityId:(globe.detailId||globe.selected));
  let entity=item?.entity,position=item?.position;
  const manual=item&&globe.entityScene?.manualSample?.(item);
  if(manual?.position){
    // The fleet observation can still say parked/zero RPM during a manual
    // takeover. Listen to the same native sample that drives the visible model.
    entity={...entity,...manual,entity_id:entity.entity_id,kind:'uam',flight_phase:manual.stage,
      grounded:manual.airborne===false,quality:manual.quality,motor_state:manual.motor_state};
    position=globe.C?.Cartesian3?.fromDegrees(manual.position.longitude,manual.position.latitude,manual.position.altitude_m)??position;
  }else if(globe.cockpit?.active&&globe.cockpit.single&&globe.flightLayer?.sample?.position || !globe.cockpit?.active&&globe.flightAnchor&&globe.followedFlightSample){
    const single=globe.cockpit?.active&&globe.cockpit.single;
    const sample=single?globe.flightLayer.sample:globe.followedFlightSample;
    entity={...sample,entity_id:'preview:selected-flight',kind:'uam',flight_phase:sample.stage,
      grounded:sample.airborne===false||sample.kind==='ground',visual_asset_id:typeof globe.flightLayer?.asset==='function'?globe.flightLayer.asset()?.asset_id:globe.flightLayer?.asset?.asset_id};
    position=single?globe.C.Cartesian3.fromDegrees(sample.position.longitude,sample.position.latitude,sample.position.altitude_m):globe.flightAnchor;
  }else if(entity){
    if(globe.entityScene?.layers?.[entity.kind]?.visible===false)return null;
    const samples=globe.entityScene?.samples,time=samples?.renderTime(entity.entity_id);
    const telemetry=Number.isFinite(time)?samples.telemetryAt(entity.entity_id,time,{}):{};
    entity={...entity};
    for(const key of ['rotor_radps','tilt_deg']){
      // DisplaySamples uses zero for absent channels. Absence is not a
      // measured motor stop, for either simulated or Physical entities.
      if(!Number.isFinite(entity[key]))continue;
      if(Number.isFinite(telemetry[key]))entity[key]=telemetry[key];
    }
  }
  const camera=globe.viewer?.camera?.positionWC;
  if(!entity||!position||!camera)return null;
  return {entity,cockpit:Boolean(globe.cockpit?.active),distance:Math.hypot(camera.x-position.x,camera.y-position.y,camera.z-position.z)};
}

// Full-fleet ranking is limited to four times a second. Only the six chosen
// neighbours read interpolated telemetry; the render loop is never involved.
const acousticSelections=new WeakMap();
export function sceneSoundSample(globe,now=globalThis.performance.now()){
  if(!globe||globe.entryActive||globe.sceneMode==='2d')return null;
  const camera=globe.viewer?.camera,origin=camera?.positionWC;
  if(!origin||![origin.x,origin.y,origin.z].every(Number.isFinite))return null;
  const selected=selectedSoundSample(globe),selectedId=selected?.entity?.entity_id;
  const cockpit=Boolean(globe.cockpit?.active);
  const spatial=position=>{
    const x=position.x-origin.x,y=position.y-origin.y,z=position.z-origin.z;
    const distance=Math.hypot(x,y,z),right=camera.rightWC;
    return {distance,pan:right&&distance>0?Math.max(-1,Math.min(1,(x*right.x+y*right.y+z*right.z)/distance)):0};
  };
  const visible=item=>item?.position&&['uam','aircraft'].includes(item.entity?.kind)
    &&globe.entityScene?.layers?.[item.entity.kind]?.visible!==false;
  // An aircraft crossing a deck under no rotor thrust is still making a sound,
  // and when it happens it is one of the nearest things to the listener. This
  // is only the ranking pre-filter; whether anything is actually audible is
  // still decided from the profile, so admitting a mover that turns out to be
  // silent costs a place in the shortlist and nothing else. Parked stays
  // excluded: what can be heard is the movement, not the presence.
  // Ground movement only, and the same test the profile uses to decide there is
  // a roll to hear: admitting anything that merely moves would let an airborne
  // aircraft with stopped rotors -- silent either way -- take one of the six
  // places from something that can actually be heard.
  const rolling=e=>{
    if(!(e.grounded===true||e.airborne===false
      ||['parked','charge','gate_in','gate_out','arrived','complete'].includes(e.flight_phase??e.stage)))return false;
    const velocity=e.velocity_ecef_mps;
    return (Number.isFinite(e.speed_mps)?e.speed_mps
      :Array.isArray(velocity)&&velocity.length===3&&velocity.every(Number.isFinite)?Math.hypot(...velocity):0)>.25;
  };
  const running=e=>!['stale','invalid','unavailable'].includes(e.quality)
    &&!['off','shutdown'].includes(e.motor_state)
    &&(e.kind!=='uam'||rolling(e)||(Number.isFinite(e.rotor_radps)?e.rotor_radps>0:
      e.source!=='physical_uam'&&!e.grounded&&!['parked','charge','gate_in','gate_out','arrived','complete'].includes(e.flight_phase??e.stage)));
  let cache=acousticSelections.get(globe);
  if(!cache||now-cache.time>=250||now<cache.time||cache.selectedId!==selectedId){
    const ranked=[];
    for(const [id,item] of globe.items??[]){
      if(id===selectedId||!visible(item)||!running(item.entity))continue;
      const {distance}=spatial(item.position);
      if(!Number.isFinite(distance)||distance>2500)continue;
      // A small retention preference avoids swapping voices at a distance tie.
      ranked.push({id,score:distance*(cache?.ids.includes(id)?.85:1)});
    }
    ranked.sort((a,b)=>a.score-b.score);
    cache={time:now,selectedId,ids:ranked.slice(0,6).map(v=>v.id)};acousticSelections.set(globe,cache);
  }
  const nearby=[];
  for(const id of cache.ids){
    const item=globe.items.get(id);if(!visible(item)||!running(item.entity)||id===selectedId)continue;
    const entity={...item.entity},samples=globe.entityScene?.samples,time=samples?.renderTime(id);
    const telemetry=Number.isFinite(time)?samples.telemetryAt(id,time,{}):{};
    for(const key of ['rotor_radps','tilt_deg'])if(Number.isFinite(entity[key])&&Number.isFinite(telemetry[key]))entity[key]=telemetry[key];
    nearby.push({entity,...spatial(item.position)});
  }
  let pan=0;
  const selectedItem=globe.items?.get(selectedId);
  if(!cockpit&&selectedItem?.position)pan=spatial(selectedItem.position).pan;
  const e=selected?.entity,velocity=e?.velocity_ecef_mps;
  const speed=Number.isFinite(e?.speed_mps)?e.speed_mps:Array.isArray(velocity)?Math.hypot(...velocity):0;
  // A close listener hears an outdoor bed; orbit/map overview remains quiet.
  const height=camera.positionCartographic?.height;
  const local=cockpit||(selected?.distance<2500)||(Number.isFinite(height)&&height<2000);
  return {...selected,cockpit,pan,nearby,environment:local&&e?.kind!=='satellite'?{speed:Math.min(1,Math.max(0,speed/80))}:null};
}

export class EntitySoundControls {
  constructor({document=globalThis.document,audio,readSample,storage}={}){
    Object.assign(this,{document,audio,readSample});this.timer=null;this.destroyed=false;
    try{this.storage=storage??globalThis.localStorage;const saved=this.storage?.getItem('aerodt.sound.volume.v1');
      if(saved!==null&&saved!==undefined&&saved!=='')audio.setVolume(Number(saved));}catch{}
    this.button=document.getElementById('sound-toggle');this.slider=document.getElementById('sound-volume');
    this.output=document.getElementById('sound-volume-value');this.status=document.getElementById('sound-status');
    this.preferred=true;
    try{this.preferred=this.storage?.getItem('aerodt.sound.enabled.v1')!=='false';}catch{}
    this.activate=async()=>{
      if(!this.preferred||this.destroyed||this.document.hidden)return false;
      if(audio.enabled&&audio.context?.state==='running')return true;
      if(this.activation)return this.activation;
      this.activation=audio.enable().then(enabled=>{
        if(!this.preferred||this.destroyed){audio.disable();return false;}
        this.error=enabled?'':'소리 시작 대기 · 화면을 클릭하면 다시 시도합니다.';this.sync();return enabled;
      }).finally(()=>{this.activation=null;});
      return this.activation;
    };
    const soundToggle=target=>target?.closest?.('#sound-toggle,[data-settings-source-id="sound-toggle"]');
    this.unlock=event=>{if(event.isTrusted&&!soundToggle(event.target)&&this.preferred)void this.activate();};
    this.clickSound=event=>{
      if(!event.isTrusted||soundToggle(event.target)||!this.preferred)return;
      const button=event.target?.closest?.('button,[role="button"],summary,a[href]');
      if(!button||button.disabled||button.getAttribute('aria-disabled')==='true')return;
      void this.activate().then(ok=>{if(ok)audio.playEffect('click');});
    };
    this.cue=event=>{if(this.preferred)audio.playEffect(event.detail?.kind);};
    document.addEventListener('pointerdown',this.unlock,true);document.addEventListener('keydown',this.unlock,true);
    document.addEventListener('click',this.clickSound,true);document.addEventListener('aerodt:sound-cue',this.cue);
    this.button.onclick=async()=>{
      if(this.destroyed)return;
      this.preferred=!this.preferred;
      try{this.storage?.setItem('aerodt.sound.enabled.v1',String(this.preferred));}catch{}
      if(!this.preferred){audio.disable();this.error='';this.sync();return;}
      await this.activate();this.sync();
    };
    this.slider.value=String(Math.round(audio.volume*100));
    this.slider.oninput=()=>{
      audio.setVolume(Number(this.slider.value)/100);
      try{this.storage?.setItem('aerodt.sound.volume.v1',String(audio.volume));}catch{}
      this.paint();
    };
    this.mixSliders=[];
    for(const channel of ['traffic','environment']){
      const slider=document.getElementById('sound-'+channel),output=document.getElementById('sound-'+channel+'-value');
      if(!slider)continue;
      const key='aerodt.sound.'+channel+'.v1';
      try{const saved=this.storage?.getItem(key);if(saved!==null&&saved!==undefined&&saved!=='')audio.setMix(channel,Number(saved));}catch{}
      const paint=()=>{slider.value=String(Math.round(audio[channel+'Volume']*100));if(output)output.textContent=slider.value+'%';};
      slider.oninput=()=>{audio.setMix(channel,Number(slider.value)/100);try{this.storage?.setItem(key,String(audio[channel+'Volume']));}catch{}paint();};
      this.mixSliders.push(slider);paint();
    }
    this.visibility=async()=>{await audio.setHidden(document.hidden);if(!this.destroyed)this.sync();};
    document.addEventListener('visibilitychange',this.visibility);
    audio.hidden=Boolean(document.hidden);this.paint();
  }
  paint(){
    this.button.setAttribute('aria-pressed',String(this.preferred));
    this.button.setAttribute('aria-label',this.preferred?'전체 사운드 끄기':'전체 사운드 켜기');
    this.button.title=this.preferred?'전체 사운드 켜짐 — 클릭하여 끄기':'전체 사운드 꺼짐 — 클릭하여 켜기';
    this.output.textContent=`${Math.round(this.audio.volume*100)}%`;
    const sample=this.sample;
    const state=this.error||(!this.preferred?'음소거 · 사운드 버튼으로 켜세요.':!this.audio.enabled?'사운드 켜짐 · 첫 클릭 또는 키 입력 후 시작':this.document.hidden?'백그라운드 음소거':
      !sample?'3D 시점에서 환경·기체 소리가 재생됩니다.':
      !sample.entity?'환경음 · 주변 기체 '+(sample.nearby?.length??0)+'대 · 거리·방향 반영':
      sample.entity.kind==='satellite'?'위성 연출음 · 실제 우주 소리가 아닙니다.':
      sample.entity.kind==='uam'?(Number.isFinite(sample.entity.rotor_radps)?`RPM 연동 · 주변 ${sample.nearby?.length??0}대 · 환경음 · 합성 음향`:
        sample.entity.source==='physical_uam'?'RPM 관측 없음 · 모터음 대기':'비행 단계 기반 대표 합성음 · RPM 미측정'):'항공기 대표 합성음 · 실제 엔진 상태와 다를 수 있습니다.');
    if(this.status.textContent!==state)this.status.textContent=state;
  }
  tick(){try{this.sample=this.readSample();this.audio.update(this.sample);}catch{this.sample=null;this.audio.update(null);}this.paint();}
  sync(){
    clearInterval(this.timer);this.timer=null;
    if(this.audio.enabled&&!this.document.hidden){this.tick();this.timer=setInterval(()=>this.tick(),50);}
    this.paint();
  }
  async destroy(){
    this.destroyed=true;clearInterval(this.timer);this.timer=null;
    this.document.removeEventListener('pointerdown',this.unlock,true);this.document.removeEventListener('keydown',this.unlock,true);
    this.document.removeEventListener('click',this.clickSound,true);this.document.removeEventListener('aerodt:sound-cue',this.cue);
    this.document.removeEventListener('visibilitychange',this.visibility);this.button.onclick=null;this.slider.oninput=null;
    for(const slider of this.mixSliders)slider.oninput=null;
    await this.audio.destroy();
  }
}
