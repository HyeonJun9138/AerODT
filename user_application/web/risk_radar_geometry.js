// Read-only local presentation math. No trajectory or aircraft state is created here.
const RAD=Math.PI/180;
export const located=e=>Boolean(e&&Number.isFinite(e.latitude_deg)&&Number.isFinite(e.longitude_deg)&&Math.abs(e.latitude_deg)<=90&&Math.abs(e.longitude_deg)<=180);

export function localEnu(point,anchor){
  if(!located(point)||!located(anchor))return null;
  const origin=ecef(anchor),delta=ecef(point).map((value,i)=>value-origin[i]),[east,north]=enuAxes(anchor);
  return {east_m:dot(east,delta),north_m:dot(north,delta)};
}
function ecef(point){
  const lat=point.latitude_deg*RAD,lon=point.longitude_deg*RAD,h=Number.isFinite(point.altitude_m)?point.altitude_m:0;
  const n=6378137/Math.sqrt(1-6.69437999014e-3*Math.sin(lat)**2);
  return [(n+h)*Math.cos(lat)*Math.cos(lon),(n+h)*Math.cos(lat)*Math.sin(lon),(n*(1-6.69437999014e-3)+h)*Math.sin(lat)];
}
function enuAxes(point){const lat=point.latitude_deg*RAD,lon=point.longitude_deg*RAD;
  return [[-Math.sin(lon),Math.cos(lon),0],[-Math.sin(lat)*Math.cos(lon),-Math.sin(lat)*Math.sin(lon),Math.cos(lat)]];}
const dot=(a,b)=>a.reduce((sum,value,i)=>sum+value*b[i],0);

export function reanchorPrediction(point,anchor,current){
  const offset=localEnu(anchor,current);if(!offset)return null;
  const [e,n]=enuAxes(current),[a,b]=enuAxes(anchor),r=dot(e,a),s=dot(e,b),u=dot(n,a),v=dot(n,b);
  const {cov_ee:ee,cov_nn:nn,cov_en:en}=point;
  // Only the served horizontal plane is transformed; no future altitude is inferred.
  return {...point,east_m:offset.east_m+r*point.east_m+s*point.north_m,north_m:offset.north_m+u*point.east_m+v*point.north_m,
    cov_ee:r*r*ee+s*s*nn+2*r*s*en,cov_nn:u*u*ee+v*v*nn+2*u*v*en,cov_en:r*u*ee+s*v*nn+(r*v+s*u)*en};
}

export function headingUp(east,north,heading){
  const c=Math.cos(heading*RAD),s=Math.sin(heading*RAD);
  return {x:c*east-s*north,y:-s*east-c*north};
}

export function uncertaintyEllipse(point,heading){
  const {cov_ee:ee,cov_nn:nn,cov_en:en}=point??{};
  if(![ee,nn,en,heading].every(Number.isFinite)||ee<0||nn<0||ee*nn-en*en < -1e-7)return null;
  const c=Math.cos(heading*RAD),s=Math.sin(heading*RAD);
  // A = [[cos h, -sin h], [-sin h, -cos h]], Cscreen = A Cenu A^T.
  const xx=c*c*ee+s*s*nn-2*c*s*en,yy=s*s*ee+c*c*nn+2*c*s*en;
  const xy=c*s*(nn-ee)+(s*s-c*c)*en,delta=Math.hypot(xx-yy,2*xy);
  return {rx:2*Math.sqrt(Math.max(0,(xx+yy+delta)/2)),ry:2*Math.sqrt(Math.max(0,(xx+yy-delta)/2)),angle:.5*Math.atan2(2*xy,xx-yy)/RAD};
}

export function checkedRiskResponse(value,{entityId,epoch,stateTime,radius,horizon}){
  if(!value||value.schema_version!==1||value.ownship_id!==entityId||value.epoch!==epoch||
    !Number.isFinite(value.state_time)||!Number.isFinite(stateTime)||value.state_time>stateTime+1||stateTime-value.state_time>3||
    value.radius_m!==radius||value.horizon_s!==horizon||!located(value.ownship)||value.ownship.entity_id!==entityId||
    !['ready','warming_up','unavailable','disabled'].includes(value.status)||!Array.isArray(value.tracks)||value.tracks.length>1000)return null;
  const seen=new Set();
  const tracks=value.tracks.filter(track=>track&&typeof track.entity_id==='string'&&track.entity_id!==entityId&&located(track)&&
    !seen.has(track.entity_id)&&seen.add(track.entity_id)).map(track=>{
    const branches=track.prediction?.branches;
    const valid=Number.isSafeInteger(track.continuity_id)&&track.continuity_id>=0&&value.status==='ready'&&track.status==='ready'&&Array.isArray(branches)&&branches.length>0&&branches.length<=3&&
      Math.abs(branches.reduce((sum,b)=>sum+(Number.isFinite(b?.weight)?b.weight:10),0)-1)<.03&&branches.every(branch=>
        branch&&Number.isFinite(branch.weight)&&branch.weight>=0&&branch.weight<=1&&Array.isArray(branch.points)&&branch.points.length>=2&&branch.points.length<=128&&
        branch.points.every((p,i)=>p&&[p.t_s,p.east_m,p.north_m].every(Number.isFinite)&&Math.abs(p.east_m)<=1e6&&Math.abs(p.north_m)<=1e6&&
          p.t_s>=0&&p.t_s<=horizon+.001&&(!i||p.t_s>branch.points[i-1].t_s)&&uncertaintyEllipse(p,0)));
    const probabilities=track.prediction?.type_probabilities;
    return {...track,prediction:valid?{branches:branches.map(branch=>({...branch,points:branch.points.map(p=>({...p}))})),
      type_probabilities:Array.isArray(probabilities)?probabilities.filter(p=>p&&typeof p.type==='string'&&Number.isFinite(p.probability)&&p.probability>=0&&p.probability<=1).slice(0,12):[]}:null};
  });
  return {...value,ownship:{...value.ownship},tracks};
}

export function radarLayout({width,height,expanded=false,selection}){
  const margin=12,available=Math.max(120,width-2*margin),panelWidth=Math.min(expanded?500:304,available);
  const panelHeight=Math.min(expanded?720:530,Math.max(100,height-2*margin));
  let left=width-margin-panelWidth,top=Math.max(margin,(height-panelHeight)/2),boxHeight=panelHeight;
  if(selection&&selection.right>left-8&&selection.left<left+panelWidth&&selection.bottom>top-8&&selection.top<top+boxHeight){
    const rightSpace=width-selection.right-2*margin;
    if(rightSpace>=280){const adjustedWidth=Math.min(panelWidth,rightSpace);left=width-margin-adjustedWidth;
      return {left,top,width:adjustedWidth,height:boxHeight,collapsed:false};}
    const below=height-selection.bottom-2*margin;
    if(below>=144){top=selection.bottom+margin;boxHeight=Math.min(panelHeight,below);}
    else return {left:Math.max(margin,width-172),top:height-52,width:160,height:40,collapsed:true};
  }
  return {left,top,width:panelWidth,height:boxHeight,collapsed:false};
}
