// Presentation of the manual session's server-owned ground procedure.
// No wall-clock progress, polling or modification of aircraft state.
import {PassengerBoardingLayer} from './passenger_boarding.js';
import {cablePrimitive,CABLE_RADIUS_M} from './charging_cables.js';
export function turnaroundVisual(sample){
 const g=sample?.ground_handling;if(!g?.position||!g.start_s&&g.start_s!==0)return null;
 const elapsed=Math.max(0,sample.time_s-g.start_s),release=g.release_s;
 const after=Number.isFinite(release)?sample.time_s-release:null;
 const open=Number.isFinite(g.door_open)?g.door_open:after===null?Math.min(1,elapsed/2):Math.max(0,1-Math.max(0,after-3)/2);
 const progress=Math.max(0,Math.min(1,(elapsed-g.crew_start_s)/Math.max(.01,g.crew_walk_s)));
 const cable=Boolean(g.socket)&&Array.isArray(g.crew_path)&&g.charge_requested_s!==null&&elapsed>=g.crew_start_s&&(after===null||after<3);
 return {g,elapsed,open,progress,cable};
}
export class ManualTurnaround{
 constructor(C,viewer,{assets,warning=()=>{}}){Object.assign(this,{C,viewer,assets,warning});this.scene=viewer.scene;this.owned=[];}
 clear(){
  this.people?.destroy();this.worker?.destroy();this.people=this.worker=null;this.operation=null;
  if(this.cable)this.scene.primitives.remove(this.cable);this.cable=null;this.cableKey=null;
  for(const e of this.owned)this.viewer.entities.remove(e);this.owned=[];
  for(const node of this.doors??[])if(node&&!node.isDestroyed?.()){node.matrix=node.originalMatrix;node.aerodtTurnaroundAngle=undefined;}
  this.doors=null;this.doorModel=null;this.anchor=null;
 }
 update(sample,model,asset,plan,shown){
  const C=this.C,v=turnaroundVisual(sample),g=v?.g;
  if(!v){if(this.operation)this.clear();return;}
  const alightingStart=g.alighting_start_s===undefined?g.start_s+2:g.alighting_start_s;
  const key=`${g.start_s}:${g.vertiport}:${g.gate}:${alightingStart??'door'}:${g.charge_requested_s??'waiting'}`;
  if(this.operation!==key){
   this.clear();this.operation=key;
   const makePlan=(walk,start)=>({vehicle:plan.vehicle,alighting:walk,legs:[{stage:'charge',start_s:start,path:[[...g.position]]}]});
   if(g.walk?.count&&Number.isFinite(alightingStart))this.people=new PassengerBoardingLayer(C,this.scene,makePlan(g.walk,alightingStart),this.assets,this.warning);
   if(g.crew_path){
    const distance=Math.max(.01,g.crew_walk_s*.9),schedule={count:1,path:g.crew_path,distances_m:[0,distance],walk_mps:.9,walk_s:g.crew_walk_s,enter_s:5,duration_s:g.crew_walk_s+5,release_s:[0],asset_id:'kenney_blocky_person_q',height_m:1.75};
    this.worker=new PassengerBoardingLayer(C,this.scene,makePlan(schedule,g.start_s+g.crew_start_s),this.assets,this.warning);
   }
   const sill=asset?.cockpit?.ground_door?.height_m;
   if(sill>0&&g.door&&C.Transforms.headingPitchRollQuaternion){
    const h=g.heading_deg*Math.PI/180;
    for(let i=0;i<5;i++){
     const right=g.door_side*(.13+i*.26),height=Math.max(.08,sill*(1-i/5));
     const at=C.Cartesian3.fromDegrees(g.door[0]+Math.cos(h)*right/(111320*Math.cos(g.door[1]*Math.PI/180)),g.door[1]-Math.sin(h)*right/111320,g.position[2]+height/2);
     this.owned.push(this.viewer.entities.add({position:at,orientation:C.Transforms.headingPitchRollQuaternion(at,new C.HeadingPitchRoll(h-Math.PI/2,0,0)),box:{dimensions:new C.Cartesian3(.70,.28,height),material:C.Color.fromCssColorString('#707f86')},show:false}));
    }
   }
  }
  this.people?.update(sample.time_s,shown);this.worker?.update(sample.time_s,shown&&g.phase!=='released');
  for(const step of this.owned)step.show=shown&&v.open>.6;
  const spec=asset?.cockpit?.ground_door;
  if(model?.ready&&spec){
   if(this.doorModel!==model){this.doors=['right','left'].map(side=>model.getNode(spec.nodes[side]));this.doorModel=model;}
   for(const [i,node] of (this.doors??[]).entries())if(node){
    // Index 0 is the starboard hatch; a positive angle swings its free edge
    // outward. Same sign as showDoors in cabin_passengers.js.
    const active=(g.door_side>0?0:1)===i,angle=active?v.open*spec.open_deg*Math.PI/180*(i===0?1:-1):0;
    // A door that has not moved keeps its matrix: rewriting it every frame
    // dirtied the model's node tree for nothing while the aircraft stood.
    if(node.aerodtTurnaroundAngle===angle)continue;node.aerodtTurnaroundAngle=angle;
    const rotation=C.Matrix4.fromRotationTranslation(C.Matrix3.fromRotationY(angle));
    node.matrix=C.Matrix4.multiply(node.originalMatrix,rotation,new C.Matrix4());
   }
  }
  // The stand does not move: its Cartesian is made once per procedure.
  if(!this.anchor||this.anchorKey!==key){this.anchor=C.Cartesian3.fromDegrees(...g.position);this.anchorKey=key;}
  const near=C.Cartesian3.distance(this.scene.camera.positionWC,this.anchor)<650;
  if(!v.cable||!shown||!near){if(this.cable)this.scene.primitives.remove(this.cable);this.cable=null;this.cableKey=null;return;}
  // Quantise the carrying geometry to 10 Hz; connected geometry is built once.
  const step=Math.floor(v.progress*100)/100,cableKey=`${key}:${step}`;if(cableKey===this.cableKey)return;
  const [a,b]=g.crew_path,z=g.position[2],end=[a[0]+(b[0]-a[0])*step,a[1]+(b[1]-a[1])*step,z+.9];
  const outlet=[a[0],a[1],z+.95],mid=[(outlet[0]+end[0])/2,(outlet[1]+end[1])/2,z+.05];
  if(Math.hypot(end[0]-outlet[0],end[1]-outlet[1])<1e-8)return;
  const geometry={points:[outlet,[outlet[0],outlet[1],z+.08],mid,[end[0],end[1],z+.15],end],radius:CABLE_RADIUS_M};
  if(this.cable)this.scene.primitives.remove(this.cable);
  this.cable=this.scene.primitives.add(cablePrimitive(C,geometry));this.cableKey=cableKey;
 }
 destroy(){this.clear();}
}
