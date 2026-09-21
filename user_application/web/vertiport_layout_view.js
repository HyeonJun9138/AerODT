// Saved layout geometry -> interactive SVG. Metres are never re-designed here.
import {buildSvg} from './dom_builder.js';
import {STATUS,RESOURCE_NAMES,resourceState} from './vertiport_operations.js';
import {groundRoutes,routeMovements,flowDelay,FLOW_PERIOD_MS} from './vertiport_ground_routes.js';
export function uprightLayout(layout,resources) {
  const angle=(Number(layout.frame?.heading_deg)||0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const point=([x,y])=>[x*c-y*s,x*s+y*c];
  const corners=(layout.platform?.corners_m??[[-50,-40],[50,-40],[50,40],[-50,40]]).map(point);
  return {corners,resources:resources.map(r=>({...r,...(r.center_m?{center_m:point(r.center_m)}:{}),...(r.points_m?{points_m:r.points_m.map(point)}:{})})),
    min:[Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1]))],max:[Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))]};
}
// Charger labels live outside the deck, not on top of gates. The cabinet itself
// stays at its real position and a leader links it to its selectable badge.
export function chargerLabels(resources,min,max,font) {
  const labels=new Map(),mid=(min[0]+max[0])/2;
  for(const side of [-1,1]){
    const group=resources.filter(r=>r.kind==='charger'&&(r.center_m[0]<mid?-1:1)===side).sort((a,b)=>{
      const dy=b.center_m[1]-a.center_m[1];
      return Math.abs(dy)>1e-6?dy:a.id.localeCompare(b.id,undefined,{numeric:true});
    });
    const rows=[];for(const r of group){const y=Math.max(-r.center_m[1],rows.length?rows.at(-1).y+font*1.9:-max[1]);rows.push({r,y});}
    const shift=Math.max(0,(rows.at(-1)?.y??0)+font*.7+min[1]);
    for(const {r,y} of rows)labels.set(r.key,{x:(side<0?min[0]:max[0])+side*font*2.1,y:y-shift,width:font*3.1,height:font*1.35});
  }
  return labels;
}
// `states` is a resource key -> {state, occupants} map read from the day being
// flown. When it is given it is the answer; the example projection is only for
// when no day is loaded.
export function layoutView(document,record,resources,flights,closures,now,{demo=true,selected,onSelect=()=>{},states=null,movements=null,motion=null}={}) {
  const s=(tag,props,...children)=>buildSvg(document,tag,props,...children),l=record.layout??{};
  const plan=uprightLayout(l,resources),[x0,y0]=plan.min,[x1,y1]=plan.max;
  const width=Math.max(1,x1-x0),height=Math.max(1,y1-y0),font=Math.max(width/220,height/165)*10,margin=font;
  const badges=chargerLabels(plan.resources,plan.min,plan.max,font),rail=badges.size?font*3.9:0;
  const top=Math.min(-y1,...[...badges.values()].map(b=>b.y-b.height/2)),bottom=Math.max(-y0,...[...badges.values()].map(b=>b.y+b.height/2));
  const svg=s('svg',{class:'vp-layout',viewBox:`${x0-margin-rail} ${top-margin} ${width+2*(margin+rail)} ${bottom-top+2*margin}`,role:'group','aria-label':`${record.name} 자원 레이아웃`});
  svg.setAttribute('data-route-motion',motion===null?'auto':motion?'on':'off');
  const points=ps=>(ps??[]).map(([x,y])=>`${x},${-y}`).join(' ');
  const routes=groundRoutes(plan.resources,routeMovements(movements,flights,now,demo&&!states));
  const routeLayer=s('g',{class:'vp-route-layer','aria-hidden':'true'});
  for(const route of routes){
    const line=points(route.points),g=s('g',{class:'vp-route','data-direction':route.direction,'data-route-id':route.id,
      'data-from':route.from,'data-to':route.to,style:`--route-delay:${flowDelay(route.id,now)}ms;--route-period:${FLOW_PERIOD_MS}ms`},
      s('title',{text:`${route.aircraft_id??route.flight_id} · ${route.from} → ${route.to} · 저장 유도로 경로`}));
    for(const kind of ['glow','bed','flow'])g.append(s('polyline',{points:line,class:`vp-route-${kind}`,fill:'none','vector-effect':'non-scaling-stroke'}));
    // Fixed arrowheads keep direction readable with reduced motion enabled.
    for(let i=1;i<route.points.length;i++){
      const [ax,ay]=route.points[i-1],[bx,by]=route.points[i],length=Math.hypot(bx-ax,by-ay);
      if(length<font*2)continue;
      const x=(ax+bx)/2,y=-(ay+by)/2,angle=Math.atan2(ay-by,bx-ax)*180/Math.PI,size=font*.34;
      g.append(s('path',{class:'vp-route-arrow',d:`M${-size} ${-size} L0 0 L${-size} ${size}`,
        transform:`translate(${x} ${y}) rotate(${angle})`,'vector-effect':'non-scaling-stroke'}));
    }
    routeLayer.append(g);
  }
  svg.append(s('polygon',{points:points(plan.corners),class:'vp-deck'}));
  let routesAdded=false;
  for(const r of [...plan.resources.filter(x=>x.kind==='taxiway'),...plan.resources.filter(x=>x.kind!=='taxiway')]){
    if(r.kind!=='taxiway'&&!routesAdded){svg.append(routeLayer);routesAdded=true;}
    const state=states?.get(r.key)??resourceState(r,flights,closures,now,demo),label=`${RESOURCE_NAMES[r.kind]} ${r.id} · ${STATUS[state.state]}`;
    const g=s('g',{class:'vp-resource','data-state':state.state,'data-selected':String(selected===r.key),role:'button',tabindex:'0','aria-label':label,'aria-pressed':String(selected===r.key),
      onclick:()=>onSelect(r.key),onkeydown:e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(r.key);}}},s('title',{text:label+(state.occupants.length?' · '+state.occupants.join(', '):'')}));
    if(r.kind==='taxiway')g.append(s('polyline',{points:points(r.points_m),fill:'none','stroke-width':r.width_m??4,class:'vp-taxi'}));
    else {const [x,y]=r.center_m??[0,0],radius=r.radius_m??3;
      if(r.kind==='charger'){
        const b=badges.get(r.key),edge=b.x+(b.x<x0?b.width/2:-b.width/2);
        g.append(s('path',{d:`M${x} ${-y} L${edge} ${b.y}`,class:'vp-charger-leader'}),
          s('rect',{x:x-radius,y:-y-radius,width:2*radius,height:2*radius,rx:radius*.3}),
          s('rect',{x:b.x-b.width/2,y:b.y-b.height/2,width:b.width,height:b.height,rx:font*.3,class:'vp-charger-badge'}),
          s('text',{x:b.x,y:b.y,'text-anchor':'middle','dominant-baseline':'central','font-size':font*.9,text:r.id}));
      }else g.append(s('circle',{cx:x,cy:-y,r:radius}),s('text',{x,y:-y,'text-anchor':'middle','dominant-baseline':'central','font-size':font,text:r.id}));
      if(state.state==='closed'||state.state==='conflict')g.append(s('path',{d:`M${x-radius*.6} ${-y+radius*.6} L${x+radius*.6} ${-y-radius*.6}`,class:'vp-closure-slash'}));
    }
    svg.append(g);
  }
  if(!routesAdded)svg.append(routeLayer);
  for(const route of routes){
    for(const id of [route.from,route.to]){
      const resource=plan.resources.find(r=>r.kind!=='taxiway'&&r.id===id);
      if(!resource?.center_m)continue;
      svg.append(s('circle',{class:'vp-route-terminal','data-direction':route.direction,
        cx:resource.center_m[0],cy:-resource.center_m[1],r:(resource.radius_m??3)+font*.32,
        fill:'none','vector-effect':'non-scaling-stroke','aria-hidden':'true'}));
    }
  }
  svg.append(s('title',{text:'설계 축 정렬. 충전 라벨은 외곽 안내선으로 표시하며 실제 시설 위치는 변경하지 않습니다.'}));
  return svg;
}
export function weatherIcon(document,kind) {
  const s=(tag,props,...children)=>buildSvg(document,tag,props,...children),svg=s('svg',{viewBox:'0 0 64 64',class:'vp-weather-icon','aria-hidden':'true',focusable:'false'});
  if(kind==='sun'||kind==='partly'){
    svg.append(s('circle',{cx:kind==='partly'?23:32,cy:kind==='partly'?23:32,r:11,fill:'#f8d885'}));
    for(let i=0;i<8;i++){const a=i*Math.PI/4,c=kind==='partly'?23:32;svg.append(s('path',{d:`M${c+16*Math.cos(a)} ${c+16*Math.sin(a)} L${c+21*Math.cos(a)} ${c+21*Math.sin(a)}`,stroke:'#f8d885','stroke-width':3,'stroke-linecap':'round'}));}
  }
  if(['cloud','partly','rain','snow','fog','storm'].includes(kind))svg.append(s('path',{d:'M15 43 C3 43 5 27 17 28 C20 10 44 14 45 29 C60 26 63 44 49 44 Z',fill:'#bed4df',stroke:'#e0edf3','stroke-width':1.5}));
  if(kind==='rain')for(const x of [20,32,44])svg.append(s('path',{d:`M${x} 49 l-3 7`,stroke:'#83caec','stroke-width':3,'stroke-linecap':'round'}));
  if(kind==='snow')for(const x of [20,32,44])svg.append(s('text',{x,y:59,'text-anchor':'middle',fill:'#ccefff','font-size':15,text:'✳'}));
  if(kind==='storm')svg.append(s('path',{d:'M34 43 l-8 11 h7 l-4 9 13-14 h-8 l4-6',fill:'#f5d580'}));
  if(kind==='fog')svg.append(s('path',{d:'M12 50 H51 M17 56 H46',stroke:'#a9c4cf','stroke-width':3,'stroke-linecap':'round'}));
  if(kind==='unknown')svg.append(s('text',{x:32,y:40,'text-anchor':'middle',fill:'#b1c7d2','font-size':32,text:'—'}));
  return svg;
}
