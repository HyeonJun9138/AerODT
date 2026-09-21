// Geometry and persisted presentation preferences only. No application state.
export const LAYOUT_KEY='aerodt.window-layout.v1';
export const SNAP_LABELS={left:'왼쪽',right:'오른쪽','left-top':'왼쪽 위','left-bottom':'왼쪽 아래','right-top':'오른쪽 위','right-bottom':'오른쪽 아래','bottom-left':'하단 왼쪽','bottom-centre':'하단 가운데','bottom-right':'하단 오른쪽'};
const limit=(n,a,b)=>Math.max(a,Math.min(b,n));
export function boundsFor(width,height,rail=76){const x=Math.min(rail+12,width*.25),y=Math.min(80,height*.12);return {x,y,width:Math.max(120,width-x-12),height:Math.max(100,height-y-62)};}
export function clampRect(r,a){const width=limit(r.width,Math.min(280,a.width),a.width),height=limit(r.height,Math.min(180,a.height),a.height);return {x:limit(r.x,a.x,a.x+a.width-width),y:limit(r.y,a.y,a.y+a.height-height),width,height};}
export function snapRect(key,a){
 const gap=10,side=Math.min(a.width,Math.max(Math.min(320,a.width),Math.min(440,a.width*.31))),half=(a.height-gap)/2,cell=(a.width-2*gap)/3;
 if(key.startsWith('bottom-')){if(a.width<860)return {x:a.x,y:a.y+a.height-Math.min(260,a.height),width:a.width,height:Math.min(260,a.height)};const column={'bottom-left':0,'bottom-centre':1,'bottom-right':2}[key];return {x:a.x+column*(cell+gap),y:a.y+a.height-Math.min(260,a.height*.4),width:cell,height:Math.min(260,a.height*.4)};}
 return {x:key.startsWith('right')?a.x+a.width-side:a.x,y:a.y+(key.endsWith('bottom')?half+gap:0),width:side,height:key.includes('-')?half:a.height};
}
export function snapTarget(p,a){
 if(p.y>a.y+a.height-36){const t=limit((p.x-a.x)/a.width,0,.999);return ['bottom-left','bottom-centre','bottom-right'][Math.floor(t*3)];}
 if(p.x<a.x+36||p.x>a.x+a.width-36){const side=p.x<a.x+36?'left':'right',y=(p.y-a.y)/a.height;return y<.33?side+'-top':y>.67?side+'-bottom':side;}
 return null;
}
export function resizeRect(r,edge,dx,dy,a){let left=r.x,top=r.y,right=r.x+r.width,bottom=r.y+r.height;const minW=Math.min(280,a.width),minH=Math.min(180,a.height);
 if(edge.includes('w'))left=limit(left+dx,a.x,right-minW);if(edge.includes('e'))right=limit(right+dx,left+minW,a.x+a.width);
 if(edge.includes('n'))top=limit(top+dy,a.y,bottom-minH);if(edge.includes('s'))bottom=limit(bottom+dy,top+minH,a.y+a.height);
 return {x:left,y:top,width:right-left,height:bottom-top};
}
export function placeRect(size,a,occupied=[]){
 const base=clampRect({x:a.x,y:a.y,width:size.width,height:size.height},a),candidates=[base,{...base,x:a.x+a.width-base.width},...occupied.flatMap(r=>[{...base,x:r.x+r.width+10},{...base,y:r.y+r.height+10}])];
 const overlap=(r,s)=>Math.max(0,Math.min(r.x+r.width,s.x+s.width)-Math.max(r.x,s.x))*Math.max(0,Math.min(r.y+r.height,s.y+s.height)-Math.max(r.y,s.y));
 return candidates.map(r=>clampRect(r,a)).sort((r,s)=>occupied.reduce((n,p)=>n+overlap(r,p)-overlap(s,p),0))[0];
}
export function readLayouts(storage){try{const data=JSON.parse(storage?.getItem(LAYOUT_KEY)??'null');if(data?.version!==1||!data.windows||typeof data.windows!=='object')return {};const answer={};for(const [key,r] of Object.entries(data.windows).slice(0,40)){if(r&&['x','y','width','height'].every(k=>Number.isFinite(r[k]))&&r.width>0&&r.height>0)answer[key]={x:r.x,y:r.y,width:r.width,height:r.height,snap:Object.hasOwn(SNAP_LABELS,r.snap)?r.snap:null,minimized:r.minimized===true};}return answer;}catch{return {};}}

