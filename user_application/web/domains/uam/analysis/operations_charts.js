import {buildElement as el, buildSvg as svg} from '../../../dom_builder.js';

export const value = (n, digits=0) => Number.isFinite(n) ? n.toLocaleString('ko-KR',{maximumFractionDigits:digits}) : '—';
export const minutes = n => Number.isFinite(n) ? `${value(n/60,1)}분` : '—';
export const percent = n => Number.isFinite(n) ? `${value(n,1)}%` : '—';
export const clock = n => {
  if(!Number.isFinite(n))return '—';
  const day=Math.floor(n/86400), s=Math.max(0,Math.floor(n%86400));
  return `${day?`+${day}일 `:''}${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
};

// The plot is accompanied by real buttons with the same values. Keyboard and
// touch users get the identical drill-down without needing an SVG hit target.
export function hourlyChart(doc, rows, observed, onPick) {
  const wrap=el(doc,'div',{class:'oa-hourly'}), width=720,height=182,left=34,bottom=150;
  const max=Math.max(1,...rows.flatMap(r=>[r.planned_arrivals,r.actual_arrivals]));
  const graph=svg(doc,'svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':'시간대별 계획 착륙과 실제 착륙 비교. 아래 시간 버튼으로 상세 조회'},
    svg(doc,'title',{text:'계획 착륙(회색) / 실제 착륙(청록), 단위 편'}));
  for(let tick=0;tick<=3;tick++){
    const y=bottom-tick*42;
    graph.append(svg(doc,'line',{x1:left,y1:y,x2:width-8,y2:y,stroke:'#ffffff14'}),
      svg(doc,'text',{x:left-6,y:y+4,'text-anchor':'end',class:'oa-axis',text:value(max*tick/3)}));
  }
  const step=(width-left-8)/Math.max(1,rows.length), buttons=el(doc,'div',{class:'oa-hour-buttons'});
  rows.forEach((r,i)=>{
    const x=left+i*step, future=r.hour_s>observed;
    if(r.hour_s<=observed&&observed<r.hour_s+3600)graph.append(svg(doc,'rect',{x,y:17,width:step,height:133,fill:'#7fe7df0c'}));
    for(const [series,offset,color] of [['planned_arrivals',.12,'#718591'],['actual_arrivals',.52,'#79dfd5']]){
      const h=r[series]/max*126;
      graph.append(svg(doc,'rect',{x:x+step*offset,y:bottom-h,width:Math.max(1,step*.31),height:h,rx:2,fill:color,opacity:future?.45:1}));
    }
    if(rows.length<27||i%Math.ceil(rows.length/24)===0)graph.append(svg(doc,'text',{x:x+step/2,y:171,'text-anchor':'middle',class:'oa-axis',text:`${Math.floor(r.hour_s/3600)}`}));
    buttons.append(el(doc,'button',{type:'button',class:'oa-hour-pick',title:`${clock(r.hour_s)} 계획 ${r.planned_arrivals}편 · 실제 ${r.actual_arrivals}편`,
      'data-focus':`hour-${r.hour_s}`,onclick:()=>onPick(Math.floor(r.hour_s/3600)),text:`${Math.floor(r.hour_s/3600)}시 · ${r.planned_arrivals}/${r.actual_arrivals}`}));
  });
  wrap.append(el(doc,'div',{class:'oa-legend'},el(doc,'span',{class:'oa-plan-key',text:'계획 착륙'}),el(doc,'span',{class:'oa-actual-key',text:'실제 착륙'}),el(doc,'span',{text:'단위: 편 · 시간대를 눌러 상세 보기'})),el(doc,'div',{class:'oa-plot'},graph),buttons);
  return wrap;
}

export function rankingChart(doc, rows, {label,metric,format=value,onPick,limit=12,ceiling=null,empty='표시할 기록이 없습니다.'}) {
  const list=el(doc,'div',{class:'oa-rank'}), shown=rows.slice(0,limit);
  const max=ceiling||Math.max(1,...shown.map(r=>metric(r)||0));
  for(const row of shown){
    const amount=metric(row), bar=el(doc,'i',{class:'oa-rank-fill'});
    bar.style.width=`${Math.min(100,Math.max(0,(amount||0)/max*100))}%`;
    list.append(el(doc,'button',{class:'oa-rank-row',type:'button',onclick:()=>onPick(row),
      'data-focus':label(row),
      'aria-label':`${label(row)}, ${format(amount)}, 소티 상세 보기`},
      el(doc,'span',{class:'oa-rank-label',text:label(row)}),el(doc,'span',{class:'oa-rank-track'},bar),
      el(doc,'strong',{text:format(amount)})));
  }
  if(!shown.length)list.append(el(doc,'p',{class:'oa-note',text:empty}));
  return list;
}
