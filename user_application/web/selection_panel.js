import {describeEntity,describeFlightReadouts,describeMission,describeMissionOverview,describePilotDecision,describeTrajectory,tooltipPosition} from './entity_details.js';
import {ModelPreview} from '/visualization/model_preview.js';
import {mapEntityName} from '/visualization/entity_labels.js';
import {paintPhysicalSensors} from './physical_uam_panel.js';

const PRIMARY_MODEL_WAIT_MS=12000,PREVIEW_RETRY_MS=150;

export class SelectionPanel {
  constructor(C,{creditContainer,isNavigating=()=>false,isPrimaryModelPreparing=()=>false,document:ownerDocument=globalThis.document,root=null,lookup=null}={}) {
    Object.assign(this,{isNavigating,isPrimaryModelPreparing});
    this.document=ownerDocument;this.root=root;this.$=lookup??(id=>root?(root.id===id?root:root.querySelector(`[data-selection-id="${id}"], [id="${id}"]`)):ownerDocument.getElementById(id));this.assets=new Map();this.rows=new Map();this.revision=0;this.fieldsKey='';
    this.preview=new ModelPreview(C,this.$('model-preview'),status=>{
      this.previewStatus=status;
      this.$('preview-status').textContent=({deferred:'지도 준비 후 표시',loading:'3D 준비 중',ready:'드래그 회전 · 휠 확대',error:'미리보기 불가',unavailable:'모델 미연결'})[status];
      this.$('model-preview').hidden=status==='error' || status==='unavailable';
      this.$('preview-image').hidden=!(this.thumbnail && status==='error');
      this.$('preview-empty').hidden=status==='ready' || Boolean(this.thumbnail && status==='error');
    },{creditContainer:creditContainer ?? this.$('preview-credits') ?? undefined});
  }
  setAssets(catalog) {for(const asset of catalog.assets || [])this.assets.set(asset.asset_id,asset);}
  setSensors(detail) {
    let box=this.sensorBox??this.$('physical-sensor-detail');
    if(!box){box=(this.document??document).createElement('section');box.id=this.root?`${this.root.id}-physical-sensor-detail`:'physical-sensor-detail';box.dataset.selectionId='physical-sensor-detail';this.$('mission')?.before(box);}
    this.sensorBox=box;paintPhysicalSensors(box,detail);
    if(detail&&this.$('mission-empty'))this.$('mission-empty').hidden=true;
  }
  show(entity) {
    const panel=this.$('selection');
    if(!entity){
      const revision=++this.revision;this.entityId=null;this.entity=null;this.collapsed=false;this.previewKey=null;clearTimeout(this.previewTimer);this.preview.close();this.thumbnail=null;this.setTrajectory(null);this.setMission(null);
      panel.dataset.open='false';panel.inert=true;panel.setAttribute('aria-hidden','true');this.paintRestore();
      clearTimeout(this.closeTimer);this.closeTimer=setTimeout(()=>{if(revision===this.revision)panel.hidden=true;},220);return;
    }
    if(entity.entity_id!==this.entityId) {
      this.setMission(null);this.setTrajectory(null);this.setSensors(null);
      this.entityId=entity.entity_id;this.revision++;clearTimeout(this.closeTimer);this.collapsed=false;
      this.$('selection-body')?.scrollTo?.(0,0);
      panel.hidden=false;panel.inert=false;panel.setAttribute('aria-hidden','false');
      requestAnimationFrame(()=>{if(this.entityId){panel.dataset.open='true';this.$('clear').focus({preventScroll:true});}});
    }
    this.entity=entity;this.paintRestore();
    if(this.collapsed)return;
    const asset=this.assets.get(entity.visual_asset_id),view=describeEntity(entity,asset);
    this.text('selected-kind',view.kind);this.text('selected-name',mapEntityName(entity));
    this.$('selected-quality').dataset.quality=entity.quality;
    panel.dataset.kind=entity.kind;
    this.paintReadouts(describeFlightReadouts(entity));
    if(this.$('mission-empty'))this.$('mission-empty').hidden=true;
    this.text('model-disclaimer',view.representation);
    const key=view.fields.map(field=>`${field.key}:${field.label}`).join('|');
    if(key!==this.fieldsKey) {
      this.fieldsKey=key;this.rows.clear();
      this.$('selected-detail').replaceChildren(...view.fields.map(field=>{
        const group=(this.document??document).createElement('div'),term=(this.document??document).createElement('dt'),value=(this.document??document).createElement('dd');
        term.textContent=field.label;group.append(term,value);this.rows.set(field.key,value);return group;
      }));
    }
    for(const field of view.fields){const node=this.rows.get(field.key);if(node.textContent!==field.value)node.textContent=field.value;}
    const previewKey=asset?.asset_id || 'none';
    if(this.previewKey!==previewKey) {
      this.previewKey=previewKey;this.thumbnail=null;this.$('preview-image').hidden=true;this.$('preview-image').removeAttribute('src');
      this.$('model-title').textContent=asset?.title || (asset?.temporary?'기본 시각 모델':'시각 모델 없음');
      this.$('model-attribution').textContent=asset?.attribution || '';
      this.queuePreview(asset,previewKey);void this.loadThumbnail(asset,previewKey);
    }
  }
  text(id,value) {const node=this.$(id);if(node&&node.textContent!==value)node.textContent=value;}
  // Closing the card is not letting the target go. The camera keeps riding with
  // it and the map keeps drawing it; only the reading is put away, into a chip
  // beside the layer buttons that says what is still being followed. The second
  // WebGL context of the model preview is released while it is away, because a
  // card nobody is reading should not cost a frame.
  setCollapsed(collapsed) {
    const panel=this.$('selection');
    this.collapsed=Boolean(collapsed)&&Boolean(this.entityId);
    if(this.collapsed){
      const revision=++this.revision;
      clearTimeout(this.previewTimer);this.preview.close();this.previewKey=null;
      panel.dataset.open='false';panel.inert=true;panel.setAttribute('aria-hidden','true');
      clearTimeout(this.closeTimer);this.closeTimer=setTimeout(()=>{if(revision===this.revision&&this.collapsed)panel.hidden=true;},220);
    }else if(this.entityId){
      this.revision++;clearTimeout(this.closeTimer);
      panel.hidden=false;panel.inert=false;panel.setAttribute('aria-hidden','false');panel.dataset.open='true';
      if(this.entity)this.show(this.entity);
    }
    this.paintRestore();
  }
  paintRestore() {
    const chip=this.$('selection-restore');
    if(!chip)return;
    const showing=Boolean(this.entityId&&this.collapsed);
    chip.hidden=!showing;
    if(showing)this.text('selection-restore-name',this.entity?mapEntityName(this.entity):'선택 정보');
  }
  paintReadouts(view) {
    const target=this.$('flight-readouts');if(!target)return;
    this.text('selected-source',view.source);this.text('selected-quality',view.quality);
    this.text('selected-phase',view.phase);this.text('selected-mode',view.mode||'');
    this.text('readouts-title',this.$('selection').dataset.kind==='satellite'?'궤도 상태':'비행 정보');
    const key=view.cards.map(card=>card.key).join('|');
    if(key!==this.readoutKey){
      this.readoutKey=key;this.readoutNodes=new Map();
      target.replaceChildren(...view.cards.map(card=>{
        const group=(this.document??document).createElement('div'),label=(this.document??document).createElement('dt'),dd=(this.document??document).createElement('dd');
        const value=(this.document??document).createElement('strong'),unit=(this.document??document).createElement('span'),sub=(this.document??document).createElement('small');
        const arrow=(this.document??document).createElement('i');arrow.className='readout-direction';arrow.textContent='↑';arrow.setAttribute('aria-hidden','true');
        dd.append(value,unit,arrow);group.append(label,dd,sub);
        this.readoutNodes.set(card.key,{group,label,value,unit,sub,arrow});return group;
      }));
    }
    for(const card of view.cards){
      const nodes=this.readoutNodes.get(card.key);
      for(const field of ['label','value','unit','sub'])if(nodes[field].textContent!==card[field])nodes[field].textContent=card[field];
      nodes.sub.title=card.sub;nodes.label.title=card.label;
      const angle=typeof card.angle==='number'&&Number.isFinite(card.angle);
      nodes.arrow.hidden=!angle;if(angle)nodes.arrow.style.transform=`rotate(${card.angle}deg)`;
    }
    // Reserve UAM telemetry slots even when a packet lacks attitude/tilt.
    const uam=this.$('selection').dataset.kind==='uam';
    const attitude=this.$('selected-attitude');
    if(attitude){
      attitude.hidden=!uam&&!view.attitude.length;
      this.text('selected-attitude',view.attitude.length?view.attitude.map(field=>`${field.label} ${field.value}`).join('     /     '):'Pitch —     /     Roll —');
    }
    const tilt=this.$('selected-tilt');
    if(tilt){tilt.hidden=!uam&&view.tilt===null;
      this.$('selected-tilt-fill').hidden=view.tilt===null;
      if(view.tilt===null)this.text('selected-tilt-value','—');
      if(view.tilt!==null){this.text('selected-tilt-value',`${Math.round(view.tilt)}°`);
        this.$('selected-tilt-fill').style.width=`${Math.max(0,Math.min(1,view.tilt/90))*100}%`;}
    }
  }
  queuePreview(asset,key) {
    clearTimeout(this.previewTimer);this.preview.close();this.preview.onStatus('deferred');
    const request=this.previewRequest=(this.previewRequest??0)+1,primaryDeadline=performance.now()+PRIMARY_MODEL_WAIT_MS;
    // A selection callback precedes the camera approach. Yield once so that
    // navigation can start. The primary flight GLB can still be downloading
    // after the camera arrives: do not compete with it for another large GLB.
    // A failed/missing primary or this deadline releases that extra wait;
    // navigation and hidden-tab deferral remain independent of the deadline.
    const load=()=>{
      if(!this.entityId || this.previewKey!==key || this.previewRequest!==request)return;
      if(this.isNavigating() || (performance.now()<primaryDeadline && this.isPrimaryModelPreparing?.(this.entityId))){
        this.previewTimer=setTimeout(load,PREVIEW_RETRY_MS);return;
      }
      this.previewTimer=null;void this.preview.show(asset);
    };
    this.previewTimer=setTimeout(load,PREVIEW_RETRY_MS);
  }
  // What a UAM is doing in its mission: which phase, which flight, and what the
  // service has told it. Fed from outside, because the twin's entity carries a
  // position and the mission is the scheduled day's to answer.
  setMission(detail) {
    const aircraft=detail?.state?.aircraft_id;
    if(this.entityId&&aircraft&&this.entityId!==aircraft&&this.entityId!==`scenario:${aircraft}`)return;
    const view=this.entityId?describeMission(detail):null;
    const box=this.$('mission');
    if(!box)return;
    if(!view){box.hidden=true;this.$('mission-detail').replaceChildren();this.missionKey='';this.paintProgress(null);this.paintPilotDecision(null);
      if(this.$('mission-empty'))this.$('mission-empty').hidden=true;return;}
    if(this.$('mission-empty'))this.$('mission-empty').hidden=true;
    box.hidden=false;box.dataset.holding=String(view.holding);box.dataset.mode=view.mode;
    this.text('mission-title',`${view.title} · ${view.stage}`);
    this.text('mission-note',view.note);
    this.paintProgress(view);
    this.paintMissionOverview(describeMissionOverview(detail));
    this.paintPilotDecision(describePilotDecision(detail));
    const key=view.fields.map(field=>field.key).join('|');
    if(key!==this.missionKey){
      this.missionKey=key;this.missionRows=new Map();
      this.$('mission-detail').replaceChildren(...view.fields.map(field=>{
        const group=(this.document??document).createElement('div'),term=(this.document??document).createElement('dt'),value=(this.document??document).createElement('dd');
        term.textContent=field.label;group.append(term,value);this.missionRows.set(field.key,value);return group;
      }));
    }
    for(const field of view.fields){
      const node=this.missionRows.get(field.key);
      if(node && node.textContent!==field.value)node.textContent=field.value;
    }
  }
  paintPilotDecision(view) {
    const box=this.$('mission-decision');if(!box)return;
    box.hidden=!view;
    for(const [id,value] of Object.entries({'mission-decision-title':view?.title??'',
      'mission-decision-reason':view?.reason??'','mission-decision-source':view?.source??''}))this.text(id,value);
    const fields=this.$('mission-decision-fields'),fold=this.$('mission-decision-details');
    if(!view){fields.replaceChildren();this.decisionKey='';fold.open=false;return;}
    box.dataset.level=view.level;fold.hidden=!view.fields.length;
    const key=view.fields.map(field=>field.key).join('|');
    if(key!==this.decisionKey){
      this.decisionKey=key;this.decisionRows=new Map();
      fields.replaceChildren(...view.fields.map(field=>{
        const group=(this.document??document).createElement('div'),term=(this.document??document).createElement('dt'),value=(this.document??document).createElement('dd');
        term.textContent=field.label;group.append(term,value);this.decisionRows.set(field.key,value);return group;
      }));
    }
    for(const field of view.fields){const node=this.decisionRows?.get(field.key);if(node&&node.textContent!==field.value)node.textContent=field.value;}
  }
  paintMissionOverview(view) {
    if(!this.$('mission-summary')||!view)return;
    for(const [id,value] of Object.entries({
      'mission-from':view.from,'mission-to':view.to,'mission-mode':view.mode,
      'mission-percent':view.progress,'mission-eta':view.eta,'mission-timing':view.timing,
      'mission-plan-label':view.planned,'mission-passengers':view.passengers,
      'mission-sequence':view.sequence,'mission-remaining':view.remaining,
      'mission-flow':view.flow,'mission-warning':view.warning,
    }))this.text(id,value);
    this.$('mission-from').parentElement?.setAttribute('aria-label',view.routeLabel);
    this.$('mission-timing').dataset.level=view.timingLevel;
    this.$('mission-flow').hidden=!view.flow;
    this.$('mission-warning').hidden=!view.warning;this.$('mission-warning').dataset.failed=String(view.failed);
    const fill=this.$('mission-seat-fill');fill.hidden=view.occupancy===null;
    if(view.occupancy!==null)fill.style.width=`${view.occupancy*100}%`;
    if(!this.stepNodes){
      this.stepNodes=view.steps.map(step=>{const node=(this.document??document).createElement('li');node.textContent=step.label;return node;});
      this.$('mission-steps').replaceChildren(...this.stepNodes);
    }
    view.steps.forEach((step,index)=>{
      const node=this.stepNodes[index];node.dataset.state=step.state;
      if(node.textContent!==step.label)node.textContent=step.label;
      if(step.state==='current')node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');
    });
  }
  // How far through the flight is, as a bar. A second mark shows where the plan
  // said it would be by now, so ahead and behind are one glance rather than a
  // subtraction. A flight with no plan time gets the bar and no mark.
  paintProgress(view) {
    const bar=this.$('mission-progress');
    if(!bar)return;
    if(!view || view.progress===null||view.progress===undefined){bar.hidden=true;return;}
    bar.hidden=false;
    const done=Math.max(0,Math.min(1,view.progress));
    bar.style.setProperty('--done',`${(done*100).toFixed(1)}%`);
    bar.setAttribute('aria-valuenow',String(Math.round(done*100)));
    const planned=view.plannedShare;
    const mark=this.$('mission-planned');
    if(mark){
      const show=planned!==null&&planned!==undefined;
      mark.hidden=!show;
      if(show)mark.style.setProperty('--planned',`${(Math.max(0,Math.min(1,planned))*100).toFixed(1)}%`);
    }
  }
  // The path itself is drawn on the globe; this only reports what it is.
  setTrajectory(path) {
    const view=this.entityId?describeTrajectory(path):null;
    const box=this.$('trajectory');
    if(!view){box.hidden=true;this.$('trajectory-detail').replaceChildren();this.trajectoryKey='';return;}
    box.hidden=false;
    this.$('trajectory-title').textContent=view.title;
    this.$('trajectory-note').textContent=view.note;
    const key=view.fields.map(field=>field.key).join('|');
    if(key!==this.trajectoryKey) {
      this.trajectoryKey=key;this.trajectoryRows=new Map();
      this.$('trajectory-detail').replaceChildren(...view.fields.map(field=>{
        const group=(this.document??document).createElement('div'),term=(this.document??document).createElement('dt'),value=(this.document??document).createElement('dd');
        if(field.color && field.pattern){
          const swatch=(this.document??document).createElement('span');swatch.className='prediction-swatch';
          swatch.dataset.pattern=field.pattern;swatch.style.setProperty('--prediction-color',field.color);
          swatch.setAttribute('aria-hidden','true');term.append(swatch);
        }
        const label=(this.document??document).createElement('span');label.textContent=field.label;term.append(label);
        group.append(term,value);this.trajectoryRows.set(field.key,value);return group;
      }));
    }
    for(const field of view.fields){const node=this.trajectoryRows.get(field.key);if(node.textContent!==field.value)node.textContent=field.value;}
  }
  async loadThumbnail(asset,key) {
    if(!asset?.metadata_uri?.startsWith('/visual-assets/'))return;
    try {
      const response=await fetch(asset.metadata_uri,{signal:AbortSignal.timeout(8000)});if(!response.ok)return;
      const metadata=await response.json();
      const path=metadata.thumbnail?.path;
      const candidate=metadata.thumbnail_uri || (path?asset.metadata_uri.slice(0,asset.metadata_uri.lastIndexOf('/')+1)+path:null);
      if(!candidate)return;
      const url=new URL(candidate,location.origin);
      if(url.origin!==location.origin || !url.pathname.startsWith('/visual-assets/') || this.previewKey!==key || !this.entityId)return;
      this.thumbnail=url.href;const img=this.$('preview-image');
      img.onload=()=>{if(this.thumbnail===url.href && this.previewStatus==='error'){img.hidden=false;this.$('preview-empty').hidden=true;}};
      img.onerror=()=>{if(this.thumbnail===url.href){this.thumbnail=null;img.hidden=true;this.$('preview-empty').hidden=this.previewStatus==='ready';}};
      img.alt=`${asset.title || '대표 모델'} 시각화 썸네일`;img.src=url.href;
    } catch { /* Preview remains usable without a thumbnail. */ }
  }
  hover(entity,pointer,airspace=null) {
    const tooltip=this.$('hover-card');
    if(!entity && !airspace){tooltip.hidden=true;return;}
    tooltip.hidden=false;
    if(entity){
      this.$('hover-name').textContent=mapEntityName(entity);
      const height=typeof entity.altitude_m==='number' && Number.isFinite(entity.altitude_m)?`${(entity.altitude_m/1000).toFixed(2)} km`:'고도 미수신';
      this.$('hover-detail').textContent=`${entity.kind==='satellite'?'위성':'항공기'} · ${height} · ${entity.quality==='stale'?'오래된 상태':'상태 보기'}`;
    }else{
      this.$('hover-name').textContent=airspace.name;
      const limits=[airspace.lower,airspace.upper].filter(Boolean).join(' ~ ');
      this.$('hover-detail').textContent=`${airspace.kindLabel}${limits?` · ${limits}`:''}`;
    }
    const rect=tooltip.getBoundingClientRect(),globe=this.$('globe').getBoundingClientRect();
    const p=tooltipPosition(pointer,{width:globe.width,height:globe.height},rect);
    tooltip.style.left=`${p.left}px`;tooltip.style.top=`${p.top}px`;
  }
  // A planned aircraft was clicked: the same card, saying which flight it is
  // and where it has got to. Null closes it.
  showFlight(flight,pointer) {
    const tooltip=this.$('hover-card');
    const sample=flight?.sample;
    if(!flight||!sample){if(tooltip.dataset.flight==='true'){tooltip.hidden=true;delete tooltip.dataset.flight;}return;}
    tooltip.hidden=false;tooltip.dataset.flight='true';
    const plan=flight.plan;
    this.$('hover-name').textContent=`${plan?.vehicle?.id ?? 'UAM'} · ${sample.stage_label ?? ''}`;
    const parts=[`탑승 ${sample.passengers ?? 0}/${sample.capacity ?? 0}명`,
      `배터리 ${(sample.battery_pct ?? 0).toFixed(1)}%`,
      `${Math.round(sample.position?.altitude_m ?? 0)} m`,
      `${Math.round((sample.speed_mps ?? 0)*3.6)} km/h`,
      `틸트 ${Math.round(sample.tilt_deg ?? 0)}°`];
    this.$('hover-detail').textContent=parts.join(' · ');
    const rect=tooltip.getBoundingClientRect(),globe=this.$('globe').getBoundingClientRect();
    const p=tooltipPosition(pointer,{width:globe.width,height:globe.height},rect);
    tooltip.style.left=`${p.left}px`;tooltip.style.top=`${p.top}px`;
  }
  destroy() {clearTimeout(this.closeTimer);clearTimeout(this.previewTimer);this.entityId=null;this.entity=null;this.collapsed=false;this.previewKey=null;this.preview.close();}
}

