// Opt-in standalone inspection dialog. No live entity or flight command writes.
export const frdToPreviewQuaternion=([w,x,y,z])=>[w,x,-y,-z];
export const newOperationId=(crypto=globalThis.crypto)=>Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
export function statusLabel(s){
  if(!s.enabled)return s.armed?'Test Mode ON · 수신 중지':'Test Mode OFF';
  if(!s.connected)return 'TCP 연결 대기';
  if(s.sensors){const statuses=Object.values(s.sensors).map(sensor=>sensor.status);return statuses.includes('receiving')?'센서 수신 중':statuses.includes('stale')?'센서 수신 중단':'TCP 연결됨 · 센서 대기';}
  return s.status==='receiving'?'자세 수신 중':s.status==='stale'?'센서 수신 중단':'TCP 연결됨 · 센서 대기';
}

export class TwinningTestPanel {
  constructor({document=globalThis.document,fetch=(...args)=>globalThis.fetch(...args),
    beacon=(...args)=>globalThis.navigator?.sendBeacon?.(...args),
    loadPreview=()=>import('/visualization/twinning_map.js')}={}){
    Object.assign(this,{document,fetch,beacon,loadPreview});this.generation=0;this.assetGeneration=0;this.controlRevision=0;
  }
  el(tag,text){const n=this.document.createElement(tag);if(text)n.textContent=text;return n;}
  async api(action,body){
    const r=await this.fetch('/api/twinning-test'+(action?'/'+action:''),{
      method:action?'POST':'GET',headers:action?{'Content-Type':'application/json'}:{},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
    const value=await r.json();if(!r.ok)throw Error(value.error||'수신부 요청 실패');return value;
  }
  async open(){
    if(this.dialog){this.dialog.focus();return;}
    const generation=++this.generation,d=this.dialog=this.el('dialog');d.className='tt-dialog';
    d.setAttribute('aria-label','Twinning Test');
    d.innerHTML=`<header class="tt-header"><div><small>AERODT / SENSOR MONITOR</small><h2>Twinning Test <span>ISOLATED</span></h2></div><strong data-tt="status" role="status">확인 중</strong><button data-tt="close">종료 · 닫기</button></header>
      <div class="tt-toolbar"><label class="tt-switch"><input data-tt="mode" type="checkbox"> Test Mode</label><label class="tt-model-label">비행체 <select data-tt="asset" aria-label="테스트 비행체"></select></label><button data-tt="start">수신 시작</button><button data-tt="stop">중지</button><details class="tt-settings"><summary>연결 및 정렬 설정</summary><div class="tt-settings-body"><label>수신 IP<input data-tt="host" value="0.0.0.0" aria-label="수신 IP"></label><label>TCP 포트<input data-tt="port" type="number" min="1024" max="65535" value="5005"></label><label>모델 기수 정렬<select data-tt="mount"><option value="0">기본</option><option value="90">+90°</option><option value="180">180°</option><option value="270">−90°</option></select></label><button data-tt="calibrate">현재 자세를 기준으로 설정</button><small>0.0.0.0은 모든 로컬 IPv4 인터페이스입니다. 송신 PC에는 실제 LAN IP를 입력하세요. 신뢰하는 LAN 전용이며 암호화 및 인증이 없습니다.</small></div></details></div>
      <main class="tt-layout"><section class="tt-stage"><div data-tt="preview" class="tt-preview"></div><div class="tt-map-heading"><span>GPS POSITION / 3D</span><span data-tt="gps-map-status">GPS 대기</span></div><div class="tt-map-tools"><button data-tt="camera" title="현재 GPS 위치로 이동">위치 재중심</button><select data-tt="view" aria-label="지도 시점"><option value="locked">기체 확대 고정</option><option value="follow">기체 추적</option><option value="free">자유 시점</option><option value="top">위에서 보기</option></select></div><div data-tt="devices" class="tt-devices"></div><div class="tt-map-footer"><span data-tt="model-status" role="status">지도 준비 중</span><span>최초 유효 GPS 고도 = 지면 기준</span></div><div class="tt-attribution"><span data-tt="credit"></span><div data-tt="engine-credit"></div></div></section>
      <aside class="tt-monitor"><section class="tt-card"><h3>자세 <span data-tt="attitude-status"></span></h3><div class="tt-attitude"><div class="tt-horizon"><div data-tt="horizon" class="tt-horizon-plane"><div class="tt-sky"></div><div class="tt-ground"></div></div><div class="tt-horizon-reference">━━ ━━</div><span data-tt="horizon-wait" class="tt-horizon-wait">센서 대기</span></div><div data-tt="attitude-values" class="tt-axis-values">—</div></div><small>계기: 수신 자세 / 모델: 기준 보정 적용</small><div data-tt="applied" class="tt-applied">—</div></section>
      <section class="tt-card"><h3>가속도 <span data-tt="acceleration-status"></span></h3><div data-tt="acceleration-values" class="tt-accel-values">—</div><small data-tt="acceleration-frame">Body FRD / m/s²</small></section>
      <section class="tt-card tt-gps-card"><h3>GPS <span data-tt="gps-status"></span></h3><dl data-tt="gps-values"></dl></section></aside></main>
      <section class="tt-telemetry"><div class="tt-flow"><div><small>DATA PATH</small><span class="tt-source-note">아이폰 / 중계 내부 상태 확인 불가</span></div><div data-tt="flow-nodes" class="tt-flow-nodes" data-pulse="none"><span data-tt="flow-tcp">TCP 대기</span><b>→</b><span data-tt="flow-parse">정상해석 대기</span><b>→</b><span data-tt="flow-twin">트윈 표시 대기</span></div><span data-tt="flow-state">수신 대기</span><span class="tt-isolation">실제 운항 상태 변경 없음</span></div><div class="tt-bottom-grid"><div class="tt-chart-card"><h3>자세 추이 <small>최근 60초 · deg <b class="tt-roll">R</b> <b class="tt-pitch">P</b> <b class="tt-yaw">Y</b></small></h3><div data-tt="attitude-chart" class="tt-chart"></div></div><div class="tt-chart-card"><h3>가속도 추이 <small>최근 60초 · m/s² <b class="tt-roll">X</b> <b class="tt-pitch">Y</b> <b class="tt-yaw">Z</b></small></h3><div data-tt="acceleration-chart" class="tt-chart"></div></div><div class="tt-network"><div data-tt="metrics" class="tt-metrics"></div><details><summary>해석된 수신값 및 연결 기록</summary><div class="tt-raw-popover"><pre data-tt="raw">—</pre><pre data-tt="events"></pre></div></details></div></div><span data-tt="history-status" class="tt-history-status"></span></section><p data-tt="error" role="alert"></p>`;
    this.document.body.append(d);this.$=key=>d.querySelector(`[data-tt="${key}"]`);
    d.addEventListener('cancel',e=>{e.preventDefault();void this.close();});
    this.$('close').onclick=()=>void this.close();
    this.$('mode').onchange=()=>{if(!this.$('mode').checked)void this.control('stop');this.buttons();};
    this.$('start').onclick=()=>void this.control('start',{host:this.$('host').value.trim(),port:Number(this.$('port').value),asset_id:this.$('asset').value});
    this.$('stop').onclick=()=>void this.control('stop');
    this.$('calibrate').onclick=()=>void this.control('calibrate');
    this.$('asset').onchange=()=>void this.showAsset();
    this.$('mount').onchange=()=>this.applyPose();
    this.$('camera').onclick=()=>this.preview?.recenter?.();
    this.$('view').onchange=()=>this.preview?.setView?.(this.$('view').value);
    this.onPageHide=()=>this.pageHidden();
    globalThis.addEventListener?.('pagehide',this.onPageHide);
    d.showModal();this.buttons();
    try{
      const response=await this.fetch('/api/visual-assets',{signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('모델 목록 수신 실패');
      const catalog=await response.json();if(generation!==this.generation)return;
      this.assets=(catalog.assets||[]).filter(a=>a.kind==='aircraft'&&a.uri?.startsWith('/visual-assets/'));
      for(const a of this.assets){const o=this.el('option',a.title||a.asset_id);o.value=a.asset_id;this.$('asset').append(o);}
      this.state=await this.api();if(generation!==this.generation)return;
      this.$('mode').checked=this.state.enabled;
      this.$('host').value=this.state.host;this.$('port').value=this.state.port;
      if(this.state.asset_id)this.$('asset').value=this.state.asset_id;
      this.paint();await this.showAsset();
    }catch(error){if(generation===this.generation)this.$('error').textContent=error.message;}
    if(generation===this.generation)void this.poll(generation);
  }
  buttons(){
    if(!this.dialog)return;
    const enabled=!!this.state?.enabled,mode=this.$('mode').checked;
    for(const key of ['host','port','asset'])this.$(key).disabled=enabled||this.busy;
    this.$('start').disabled=!mode||enabled||this.busy||!this.$('asset').value;
    this.$('stop').disabled=!enabled||this.busy;
    this.$('calibrate').disabled=!enabled||this.sensorStatus('attitude')!=='receiving'||this.busy;
    this.$('mode').disabled=!!this.busy;
  }
  async control(action,body){
    if(this.busy)return;this.controlRevision++;this.busy=true;this.buttons();
    if(action==='start'){this.operationId=newOperationId();body={...body,operation_id:this.operationId};}
    if(action==='stop')body={operation_id:this.operationId??null};
    try{this.state=await this.api(action,body);this.$('error').textContent='';this.paint();return true;}
    catch(e){this.$('error').textContent=e.message;if(this.state?.enabled)this.$('mode').checked=true;return false;}
    finally{this.busy=false;this.buttons();}
  }
  pageHidden(){
    if(this.operationId||this.state?.enabled)this.beacon('/api/twinning-test/stop',
      new Blob([JSON.stringify({operation_id:this.operationId??null})],{type:'application/json'}));
  }
  async poll(generation){
    if(generation!==this.generation)return;
    if(!this.busy){
      try{const revision=this.controlRevision,s=await this.api();if(generation!==this.generation)return;
        if(revision!==this.controlRevision){this.timer=setTimeout(()=>void this.poll(generation),50);return;}
        this.state=s;this.$('error').textContent='';
        if(s.enabled&&s.asset_id!==this.$('asset').value){this.$('asset').value=s.asset_id;await this.showAsset();}
        void this.pollHistory();
        this.applyPose();if(!this.paintedAt||performance.now()-this.paintedAt>200)this.paint();
      }catch(e){if(generation===this.generation){this.$('error').textContent=e.message;this.$('status').textContent='수신 서버 상태 확인 실패';}}
    }
    if(generation===this.generation)this.timer=setTimeout(()=>void this.poll(generation),50);
  }
  sensorStatus(name){return this.state?.sensors?.[name]?.status||'waiting';}
  async pollHistory(now=performance.now()){
    if(this.historyBusy||(this.historyRequestedAt!=null&&now-this.historyRequestedAt<1000))return;
    this.historyRequestedAt=now;this.historyBusy=true;const generation=this.generation;
    try{
      const response=await this.fetch('/api/twinning-test/history',{method:'GET',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error('최근 60초 기록 조회 실패');
      const history=await response.json();if(generation!==this.generation)return;
      if(this.state?.session_id!=null&&history.session_id!==this.state.session_id)return;
      this.history=history;this.renderHistory();if(this.dialog)this.$('history-status').textContent='';
    }catch(e){if(generation===this.generation&&this.dialog)this.$('history-status').textContent=e.message;}
    finally{this.historyBusy=false;}
  }
  renderHistory(){
    if(!this.dialog)return;
    for(const name of ['attitude','acceleration']){
      const host=this.$(name+'-chart');host.replaceChildren();
      const rows=(this.history?.rows||[]).filter(r=>Array.isArray(r[name])&&r[name].every(Number.isFinite));
      if(!rows.length){host.append(this.el('span','실제 센서 샘플 대기'));continue;}
      const ns='http://www.w3.org/2000/svg',svg=this.document.createElementNS(ns,'svg');
      svg.setAttribute('viewBox','0 0 400 86');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('role','img');svg.setAttribute('aria-label',name==='attitude'?'최근 60초 수신 자세':'최근 60초 수신 가속도');
      const end=this.history.now_s, start=end-60, extent=Math.max(1,...rows.flatMap(r=>r[name].map(Math.abs)));
      for(const y of [10,40,70]){const line=this.document.createElementNS(ns,'path');line.setAttribute('d',`M32 ${y} H398`);line.setAttribute('stroke','#253b4b');svg.append(line);}
      for(const [label,y] of [[extent.toFixed(1),12],['0',42],[(-extent).toFixed(1),72]]){const text=this.document.createElementNS(ns,'text');text.setAttribute('x','0');text.setAttribute('y',y);text.setAttribute('fill','#91a8b8');text.setAttribute('font-size','8');text.textContent=label;svg.append(text);}
      for(let axis=0;axis<3;axis++){
        let path='',previous=null;
        for(const row of rows){if(row.time_s<start||row.time_s>end)continue;const x=32+(row.time_s-start)/60*366,y=40-row[name][axis]/extent*30;
          path+=`${previous==null||row.time_s-previous>2?'M':'L'}${x.toFixed(2)} ${y.toFixed(2)} `;previous=row.time_s;}
        const line=this.document.createElementNS(ns,'path');line.setAttribute('d',path);line.setAttribute('stroke',['#61d8d3','#f4c879','#a99cff'][axis]);line.setAttribute('stroke-width','1.4');line.setAttribute('fill','none');svg.append(line);
      }
      for(const [label,x,anchor] of [['-60s',32,'start'],['-30s',215,'middle'],['지금',398,'end']]){const text=this.document.createElementNS(ns,'text');text.setAttribute('x',x);text.setAttribute('y','84');text.setAttribute('text-anchor',anchor);text.setAttribute('fill','#819bab');text.setAttribute('font-size','8');text.textContent=label;svg.append(text);}
      host.append(svg);
    }
  }
  // Who is sending. One chip per device: the pose views follow the selected
  // one, and the map draws all of them. With a single sender the row stays out
  // of the way, because there is nothing to choose between.
  paintDevices(s){
    const host=this.$('devices');if(!host)return;
    const devices=Array.isArray(s.devices)?s.devices:[];
    host.hidden=devices.length<2;
    if(host.hidden){host.replaceChildren();this.deviceKey='';return;}
    const key=devices.map(d=>`${d.device_id}:${d.status}:${d.connected}`).join('|')+`>${s.selected_device}`;
    if(key===this.deviceKey)return;
    this.deviceKey=key;
    host.replaceChildren(...devices.map(device=>{
      const chip=this.el('button',device.device_id);
      chip.type='button';chip.className='tt-device';
      chip.dataset.status=device.connected?device.status:'gone';
      chip.setAttribute('aria-pressed',String(device.device_id===s.selected_device));
      chip.title=`${device.device_id} · ${device.connected?'연결됨':'연결 끊김'} · 수신 ${device.count??0}건`;
      chip.onclick=()=>void this.chooseDevice(device.device_id);
      return chip;
    }));
  }
  async chooseDevice(deviceId){
    if(this.busy||deviceId===this.state?.selected_device)return;
    await this.control('select',{device_id:deviceId});
  }
  paint(){
    if(!this.dialog||!this.state)return;
    const s=this.state,f=(v,n=1)=>Number.isFinite(v)?v.toFixed(n):'—';this.paintedAt=performance.now();
    this.$('status').textContent=statusLabel({...s,armed:this.$('mode').checked});
    for(const name of ['attitude','acceleration','gps']){
      const status=this.sensorStatus(name),node=this.$(name+'-status');node.textContent={receiving:'수신 중',stale:'오래된 값',waiting:'대기'}[status]+(Number.isFinite(s.sensors?.[name]?.age_seconds)?` ${s.sensors[name].age_seconds.toFixed(1)}s`:'');node.dataset.status=status;
    }
    // A sender with no height field is not a sender whose height is disputed:
    // the first is drawn on the ground and said so, the second keeps its last
    // position rather than being placed at a baseline nobody agreed.
    const noAltitude=s.gps!=null&&(s.gps.altitude_m===null||s.gps.altitude_m===undefined);
    this.$('gps-map-status').textContent=this.sensorStatus('gps')==='receiving'?(Number.isFinite(s.gps_height_above_start_m)?'GPS 수신 중':noAltitude?'GPS 수신 중 · 고도 미전송, 기본 표시 고도 300 m':Number.isFinite(s.gps_origin_altitude_m)?'GPS 고도 기준 확인 필요 · 마지막 위치 유지':'건국대 기본 위치 · 고도 기준 대기'):this.sensorStatus('gps')==='stale'?'GPS 중단 · 마지막 위치 유지':'건국대 기본 위치 300 m · GPS 대기';
    const attitude=s.attitude;
    this.$('attitude-values').textContent=`ROLL   ${f(attitude?.roll_deg)}°\nPITCH  ${f(attitude?.pitch_deg)}°\nYAW    ${f(attitude?.yaw_deg)}°`;
    this.$('horizon').style.transform=attitude?`rotate(${-attitude.roll_deg}deg) translateY(${Math.max(-38,Math.min(38,attitude.pitch_deg))}px)`:'none';
    this.$('horizon-wait').textContent=!attitude?'센서 대기':this.sensorStatus('attitude')==='stale'?'수신 중단':'';
    this.$('applied').textContent='적용 R / P / Y  '+(attitude?(s.applied_rpy_deg||[]).map(v=>f(v)+'°').join(' / '):'—');
    const acc=s.acceleration;this.$('acceleration-values').textContent=`X  ${f(acc?.x_mps2,2)}    Y  ${f(acc?.y_mps2,2)}    Z  ${f(acc?.z_mps2,2)}`;
    this.$('acceleration-frame').textContent=`Body FRD / m/s²${acc?' / 중력 '+(acc.includes_gravity?'포함':'제외'):''}`;
    const gps=s.gps,gpsHost=this.$('gps-values');gpsHost.replaceChildren();
    for(const [key,value] of [['위도',f(gps?.latitude_deg,6)+'°'],['경도',f(gps?.longitude_deg,6)+'°'],['수신 고도',f(gps?.altitude_m)+' m'+(gps?.altitude_reference==='msl'?' MSL':gps?.altitude_reference==='wgs84_ellipsoid'?' WGS84':' (기준 미상)')],['시작점 대비 높이',f(s.gps_height_above_start_m)+' m'],['최초 기준 고도',f(s.gps_origin_altitude_m)+' m'],['정확도 H / V',f(gps?.horizontal_accuracy_m)+' / '+f(gps?.vertical_accuracy_m)+' m']]){gpsHost.append(this.el('dt',key),this.el('dd',value));}
    this.paintDevices(s);
    const metrics=this.$('metrics');metrics.replaceChildren();
    for(const [key,value] of [['PACKET RATE',f(s.receive_hz)+' Hz'],['THROUGHPUT',f(s.receive_bytes_per_second)+' B/s'],['ACCEPTED',String(s.count??0)],['SEQ / 누락',`${s.raw?.seq??'—'} / ${s.sequence_gaps??0}`],['수신 바이트',String(s.received_bytes??0)],['오류',String(s.errors??0)]]){const cell=this.el('div');cell.append(this.el('small',key),this.el('strong',value));metrics.append(cell);}
    const receiving=!!s.enabled&&!!s.connected&&Object.values(s.sensors||{}).some(sensor=>sensor.status==='receiving');
    const flow=this.$('flow-nodes'),sameSession=this.flowSession===s.session_id;
    if(receiving&&sameSession&&this.flowCount!=null&&s.count>this.flowCount){this.flowPulse=this.flowPulse==='a'?'b':'a';flow.dataset.pulse=this.flowPulse;}
    else if(!receiving||this.flowCount==null||!sameSession)flow.dataset.pulse='none';
    this.flowCount=s.count;this.flowSession=s.session_id;
    this.$('flow-tcp').textContent=s.enabled&&s.connected?'TCP 연결':'TCP 대기';this.$('flow-tcp').dataset.active=String(!!s.enabled&&!!s.connected);
    this.$('flow-parse').textContent=`정상해석 ${s.count??0}`;this.$('flow-parse').dataset.active=String(receiving);
    this.$('flow-twin').textContent=this.mapReady&&receiving?'트윈 표시 갱신':'트윈 표시 대기';this.$('flow-twin').dataset.active=String(!!this.mapReady&&receiving);
    this.$('flow-state').textContent=!s.enabled?'수신 중지':!s.connected?'TCP 연결 대기':`TCP 연결됨 / ${s.peer||'—'} / 마지막 패킷 ${s.age_seconds==null?'없음':f(s.age_seconds,1)+'초 전'}`;
    this.$('raw').textContent=s.raw?JSON.stringify(s.raw,null,2):'수신 패킷 없음';
    this.$('events').textContent=(s.events||[]).slice(-8).reverse().map(e=>`${new Date(e.at_unix_ms).toLocaleTimeString()} ${e.message}`).join('\n');
    if(this.history?.session_id!==s.session_id){this.history=null;this.renderHistory();}
    this.buttons();
  }
  async showAsset(){
    const asset=this.assets?.find(a=>a.asset_id===this.$('asset').value);if(!asset)return;
    const generation=this.generation,assetGeneration=++this.assetGeneration;
    if(!this.preview){
      const C=globalThis.Cesium;if(!C){this.$('model-status').textContent='Cesium 준비 안 됨. 페이지를 새로고침해 주세요.';return;}
      const {TwinningPreview}=await this.loadPreview();
      if(generation!==this.generation||assetGeneration!==this.assetGeneration)return;
      this.preview=new TwinningPreview(C,this.$('preview'),s=>{
        if(generation!==this.generation)return;
        this.mapReady=s==='ready';
        this.$('model-status').textContent=({ready:'3D 지도 준비됨 · 건물 없음',loading:'3D 지도 및 모델 불러오는 중',error:'3D 모델 표시 실패',imagery_error:'지도 영상 수신 오류',unavailable:'모델 없음'})[s]||s;
        if(s==='ready')this.applyPose();
      },{creditContainer:this.$('engine-credit')});
    }
    this.$('credit').textContent=asset.attribution||'';
    this.preview.setView?.(this.$('view')?.value||'locked');
    await this.preview.show(asset);this.buttons();
  }
  applyPose(){this.preview?.update?.(this.state,Number(this.$('mount').value));}
  async close(){
    if(!this.dialog||this.busy)return;
    if(!await this.control('stop'))return; // Failed stop must remain visible, not claim OFF.
    this.generation++;clearTimeout(this.timer);this.preview?.close();this.preview=null;
    globalThis.removeEventListener?.('pagehide',this.onPageHide);
    this.dialog.close();this.dialog.remove();this.dialog=null;this.state=null;this.operationId=null;this.history=null;this.historyRequestedAt=null;this.flowCount=null;this.flowSession=null;this.mapReady=false;
  }
}
