// Existing satellite telemetry/catalog presentation, not a new orbit engine.
const TITLES={live:'Live Twinning',library:'Library',simulation:'임무계획',prediction:'Prediction',analysis:'운항 분석',stakeholders:'이해관계자'};
export function earthView(globe){
  globe.motion?.cancel();globe.stopTracking();
  globe.viewer.camera.setView({destination:globe.C.Cartesian3.fromDegrees(127,20,22000000),orientation:{heading:0,pitch:-Math.PI/2,roll:0}});
  globe.viewer.scene.requestRender();
}
export class SatelliteWorkspace {
  constructor({document,workspace}){Object.assign(this,{document,workspace});this.rows=new Map();this.count=0;this.time=null;this.sources=[];this.assets=[];}
  observe(snapshot){
    // Retain only small display summaries, never another entity state store.
    this.count=snapshot.entities.filter(e=>e.kind==='satellite').length;
    this.time=snapshot.state_time;this.sources=snapshot.sources??[];
    if(Date.now()-(this.paintedAt??0)<1000)return;
    this.paintedAt=Date.now();for(const row of this.rows.values())this.paint(row);
  }
  setAssets(catalog){this.assets=(catalog?.assets??[]).filter(a=>a.kind==='satellite');for(const row of this.rows.values())this.paint(row);}
  open(kind){
    if(!TITLES[kind])return;
    if(this.rows.has(kind)){this.workspace.reveal(this.rows.get(kind).node);return;}
    const created=this.workspace.create({kind:`satellite-${kind}`,label:`Satellite / ${TITLES[kind]}`,width:430,height:420,
      onClose:()=>{const row=this.rows.get(kind);if(!row)return;this.rows.delete(kind);this.workspace.release?.(row.node);row.node.remove();}});
    const body=this.document.createElement('section');body.className='satellite-workspace';created.node.append(body);
    const row={...created,kind,body};this.rows.set(kind,row);this.paint(row);
  }
  paint({kind,body}){
    const e=(tag,text)=>{const n=this.document.createElement(tag);n.textContent=text;return n;};
    body.replaceChildren(e('small','SATELLITE DOMAIN'),e('h2',TITLES[kind]));
    if(kind==='live'){
      body.append(e('p','기존 위성 위치 스트림과 궤도 데이터 표시'),e('h3',`수신 위성 ${this.count.toLocaleString()}개`),e('p',`상태 시각: ${Number.isFinite(this.time)?new Date(this.time*1000).toISOString():'수신 대기'}`));
      for(const source of this.sources.filter(s=>['celestrak','satellite'].includes(s.id)))body.append(e('p',`${source.id}: ${source.status} ${source.message??''}`));
      body.append(e('p','지도에서 위성을 선택하면 기존 궤도와 개체 정보를 확인할 수 있습니다. UAM 운항 제어는 이 화면에서 실행하지 않습니다.'));
    }else if(kind==='library'){
      body.append(e('p','등록된 위성 시각 모델 (읽기 전용)'));
      if(!this.assets.length)body.append(e('p','등록된 위성 모델이 없습니다.'));
      for(const asset of this.assets)body.append(e('p',asset.title??asset.asset_id));
    }else{
      body.append(e('h3','준비 중'),e('p',`${TITLES[kind]}은 아직 위성 도메인에 구현되지 않았습니다. UAM 기능을 대신 연결하지 않습니다.`));
    }
  }
  destroy(){for(const row of this.rows.values()){this.workspace.release?.(row.node);row.node.remove();}this.rows.clear();}
}
