import {buildSvg} from './dom_builder.js';
import {localProjection,located,latitude,longitude,airborne,matchingForecast,pathFor,clippedPath,PHASES} from './prediction_data.js';
let serial=0;
export function predictionMap(document,{entities,ports,network,forecasts,scope,role,selected,highlight=[],horizon,now,epoch,zoom=1,layers={},example=false,size={},onPick=()=>{}}){
  const s=(tag,props,...children)=>buildSvg(document,tag,props,...children),key=`prediction-map-${++serial}`;
  const width=Math.max(240,size.width||1000),height=Math.max(120,size.height||720),cx=width/2,cy=height/2;
  const project=localProjection(scope.center),scale=Math.min((cx-38)/(scope.extent?.x??scope.radius),(cy-35)/(scope.extent?.y??scope.radius))*zoom;
  const point=p=>{const [x,y]=project.point(p);return [cx+x*scale,cy+y*scale];};
  const xy=p=>point(p).join(','),inside=p=>{const [x,y]=point(p);return x>=16&&x<=width-16&&y>=20&&y<=height-20;};
  const svg=s('svg',{class:'pred-map',viewBox:`0 0 ${width} ${height}`,role:'group','aria-label':`${role==='psu'?'전체 운항 지역':role==='vertiport'?'버티포트 주변 3 km':'선택 기체 중심'} 2D 예측 지도`});
  svg.append(s('defs',{},s('pattern',{id:key,width:50,height:50,patternUnits:'userSpaceOnUse'},s('path',{d:'M50 0H0V50',class:'pred-grid-line'}))));
  svg.append(s('rect',{width,height,fill:`url(#${key})`}));
  if(role!=='psu'){
    const r=scope.radius*scale;
    svg.append(s('circle',{cx,cy,r,fill:'#76b4ce05',stroke:'#92b7cb36','stroke-dasharray':'5 7'}));
    for(const km of role==='vertiport'?[1,2,3]:[2,4,6]){
      const radius=km*1000*scale;
      svg.append(s('circle',{cx,cy,r:radius,class:'pred-range'}),s('text',{x:cx+7,y:cy-radius+16,class:'pred-range-label',text:`${km} km`}));
    }
  }
  if(layers.routes!==false){
    const nodes=new Map([...(network?.nodes??[]),...(network?.fatos??[])].filter(located).map(n=>[n.id,n]));
    const roads=s('g',{class:'pred-network','aria-hidden':'true'});
    for(const link of network?.links??[]){const a=nodes.get(link.from),b=nodes.get(link.to);if(!a||!b)continue;
      roads.append(s('path',{d:`M${xy(a)}L${xy(b)}`,'data-segment':link.segment}));}
    svg.append(roads);
  }
  const focus=new Set([selected,...highlight]);
  if(layers.forecast!==false){
    const paths=s('g',{class:'pred-futures','aria-hidden':'true'});
    for(const entity of entities){const record=forecasts.get(entity.entity_id);if(!matchingForecast(record,entity,epoch))continue;
      const path=pathFor(record,horizon,now),points=clippedPath(path,now,horizon);if(points.length<2)continue;
      const focused=focus.has(entity.entity_id),d=points.map((p,i)=>`${i?'L':'M'}${xy(p)}`).join(' '),[x,y]=point(points.at(-1));
      const g=s('g',{'data-focused':String(focused),'data-entity-id':entity.entity_id,style:`--forecast:${path.color}`},
        s('path',{d,class:'pred-future-halo'}),s('path',{d,class:'pred-future-line'}),
        s('path',{d:`M${x} ${y-5}l5 5-5 5-5-5Z`,class:'pred-future-point'}));
      if(focused&&inside(points.at(-1)))g.append(s('text',{x:x+10,y:y-9,class:'pred-future-label',text:`+${Math.round(points.at(-1).time-now)}s`}));
      paths.append(g);
    }
    svg.append(paths);
  }
  const labels=[];
  if(layers.ports!==false)for(const port of ports.filter(located)){
    if(!inside(port))continue;const [x,y]=point(port),chosen=port.id===selected;
    const g=s('g',{class:'pred-port',transform:`translate(${x} ${y})`,'data-selected':String(chosen),role:'button',tabindex:0,
      'aria-label':`${port.name} 버티포트 선택`,onclick:()=>onPick('vertiport',port.id),onkeydown:e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();onPick('vertiport',port.id);}}},
      s('title',{text:`${port.name} · ${port.id}`}),s('rect',{x:-9,y:-9,width:18,height:18,rx:5}),s('text',{x:0,y:4,'text-anchor':'middle',class:'pred-port-symbol',text:'H'}));
    if(chosen)g.append(s('circle',{r:17,class:'pred-port-focus'}));
    if(layers.labels!==false){const text=port.name??port.id,labelWidth=text.length*11+6;
      const options=[[14,-13],[14,23],[-labelWidth-14,-13],[-labelWidth-14,23]];
      const spot=options.find(([dx,dy])=>x+dx>8&&x+dx+labelWidth<width-5&&!labels.some(b=>x+dx<b.x+b.w&&x+dx+labelWidth>b.x&&y+dy-12<b.y+16&&y+dy>b.y));
      if(spot){labels.push({x:x+spot[0],y:y+spot[1]-12,w:labelWidth});g.append(s('text',{x:spot[0],y:spot[1],class:'pred-port-name',text}));}
    }
    svg.append(g);
  }
  for(const entity of [...entities].sort((a,b)=>Number(focus.has(a.entity_id))-Number(focus.has(b.entity_id)))){
    if(!inside(entity))continue;const [x,y]=point(entity),chosen=focus.has(entity.entity_id),moving=airborne(entity);
    const g=s('g',{class:'pred-aircraft',transform:`translate(${x} ${y})`,'data-selected':String(chosen),'data-moving':String(moving),
      'data-stale':String(entity.quality==='stale'),role:'button',tabindex:chosen?0:-1,'aria-label':`${entity.name} ${PHASES[entity.flight_phase]??'상태 미상'} 선택`,
      onclick:()=>onPick('pilot',entity.entity_id),onkeydown:e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();onPick('pilot',entity.entity_id);}}},
      s('title',{text:`${entity.name} · ${PHASES[entity.flight_phase]??entity.flight_phase} · ${Math.round(entity.altitude_m??0)} m`}));
    g.append(s('circle',{r:13,class:'pred-aircraft-hit'}));
    if(chosen)g.append(s('circle',{r:17,class:'pred-aircraft-ring'}));
    if(moving)g.append(s('path',{d:'M0 -8L5 5L0 2L-5 5Z',transform:`rotate(${Number(entity.heading_deg)||0})`,class:'pred-aircraft-shape'}));
    else g.append(s('circle',{r:3.5,class:'pred-aircraft-shape'}));
    if(chosen)g.append(s('text',{x:14,y:23,class:'pred-aircraft-name',text:entity.name}));
    svg.append(g);
  }
  if(example&&role==='vertiport'){const x=cx+1400*scale,y=cy-1200*scale;
    svg.append(s('g',{class:'pred-example-contact','aria-hidden':'true'},s('circle',{cx:x,cy:y,r:15}),s('path',{d:`M${x-7} ${y}h14M${x} ${y-7}v14`}),
      s('text',{x:x+22,y:y-3,text:'미확인 표적 · 예시'}),s('text',{x:x+22,y:y+15,text:'감시 입력 연결 예정'})));}
  svg.append(s('g',{class:'pred-north','aria-hidden':'true'},s('path',{d:`M${width-30} 60V27m-7 10 7-10 7 10`}),s('text',{x:width-30,y:18,'text-anchor':'middle',text:'N'})));
  const km=scope.radius>15000?10:scope.radius>6000?5:1,length=km*1000*scale;
  svg.append(s('g',{class:'pred-scale','aria-hidden':'true'},s('path',{d:`M24 ${height-22}v6h${length}v-6`}),s('text',{x:24,y:height-30,text:`${km} km`})));
  return svg;
}

export function altitudeProfile(document,path,now,horizon){
  const points=clippedPath(path,now,horizon);if(points.length<2)return null;
  const s=(tag,props,...children)=>buildSvg(document,tag,props,...children),heights=points.map(p=>p.altitude_m),lo=Math.min(...heights)-15,hi=Math.max(...heights)+15;
  const d=points.map((p,i)=>`${i?'L':'M'}${20+(p.time-points[0].time)/(points.at(-1).time-points[0].time)*540},${64-(p.altitude_m-lo)/(hi-lo)*45}`).join(' ');
  return s('svg',{class:'pred-altitude',viewBox:'0 0 580 92',role:'img','aria-label':`예측 고도 ${Math.round(heights[0])} m에서 ${Math.round(heights.at(-1))} m`},
    s('path',{d:'M20 66H560',class:'pred-altitude-base'}),s('path',{d,class:'pred-altitude-line'}),
    s('text',{x:20,y:15,text:`${Math.round(heights[0])} m`}),s('text',{x:560,y:15,'text-anchor':'end',text:`${Math.round(heights.at(-1))} m`}),
    s('text',{x:20,y:86,text:'예측 시작'}),s('text',{x:560,y:86,'text-anchor':'end',text:`+${Math.round(points.at(-1).time-now)}초`}));
}
