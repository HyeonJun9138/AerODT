// Geometric guidance for the supplied plan. Never a clearance or flight command.
const rad=Math.PI/180,finite=Number.isFinite;
export const angleDelta=(a,b)=>((a-b+540)%360)-180;
export function routeGuidance(entity,mission={}){
 const points=mission.route_points;
 if(!finite(entity?.latitude_deg)||!finite(entity.longitude_deg)||!Array.isArray(points)||points.length<2||points.some(p=>!finite(p?.latitude_deg)||!finite(p.longitude_deg)))return null;
 const local=p=>[angleDelta(p.longitude_deg,entity.longitude_deg)*111320*Math.cos(entity.latitude_deg*rad),(p.latitude_deg-entity.latitude_deg)*111320];
 const xy=points.map(local);let selected=null;
 const explicit=mission.next_waypoint_id??mission.next_waypoint;
 const explicitIndex=explicit?points.findIndex(p=>p.id===explicit||p.name===explicit):-1;
 for(let i=1;i<xy.length;i++){
  if(explicitIndex>0&&i!==explicitIndex)continue;
  const a=xy[i-1],b=xy[i],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);if(length<.01)continue;
  const t=Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/(length*length))),nearest=[a[0]+dx*t,a[1]+dy*t],distance=Math.hypot(...nearest);
  const course=(Math.atan2(dx,dy)/rad+360)%360;
  // Heading only resolves near-equal crossing/vertex candidates, not distant legs.
  const score=distance+(finite(entity.heading_deg)?Math.abs(angleDelta(course,entity.heading_deg))*.01:0);
  if(!selected||score<selected.score)selected={index:i,score,course,crossTrackM:(a[1]*dx-a[0]*dy)/length,distanceM:Math.hypot(...b),bearing:(Math.atan2(b[0],b[1])/rad+360)%360,target:points[i],explicit:explicitIndex>0};
 }
 return selected;
}

