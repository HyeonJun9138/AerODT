// Close-range presentation only. Never changes stands, taxi paths or contact heights.
import {paintApron, rotateLayout} from './vertiport_paint.js?v=20260917-pilot-detail';
import {shellMesh, rotatePoint, rotationOf, boundsOf, cornerRadius, roundedOutline} from './vertiport_shell.js';

const segmentDistance=(p,a,b)=>{const x=b[0]-a[0],y=b[1]-a[1],n=x*x+y*y,t=n?Math.max(0,Math.min(1,((p[0]-a[0])*x+(p[1]-a[1])*y)/n)):0;return Math.hypot(p[0]-a[0]-t*x,p[1]-a[1]-t*y);};
function inside(p,ring){let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}

// Signs occupy only verified free strips outside every operational circle and lane.
// Dense custom layouts may have no free strip: omit the physical sign in that case.
export function pilotSigns(layout){
 const l=rotateLayout(layout,0),corners=l.platform?.corners_m??[],placed=[];
 if(corners.length<3)return placed;
 const bounds=boundsOf(corners),ring=roundedOutline(corners,cornerRadius(bounds.max[0]-bounds.min[0],bounds.max[1]-bounds.min[1],l.platform?.corner_radius_m));
 const zones=[...(l.fatos??[]).map(f=>({...f,kind:'FATO',clearance:f.safety_radius_m??f.radius_m})),...(l.gates??[]).map(g=>({...g,kind:'GATE',clearance:g.radius_m}))];
 for(const zone of zones){
  const radius=1.35;
  let best=null;
  for(const extra of [1.55,2.5,3.5,5])for(let k=0;k<32;k++){
   const a=k*Math.PI/16,p=[zone.center_m[0]+(zone.clearance+extra)*Math.cos(a),zone.center_m[1]+(zone.clearance+extra)*Math.sin(a)];
   if(!inside(p,ring)||ring.some((v,i)=>segmentDistance(p,v,ring[(i+1)%ring.length])<radius+.5))continue;
   if(zones.some(z=>Math.hypot(p[0]-z.center_m[0],p[1]-z.center_m[1])<z.clearance+radius))continue;
   if((l.edges??[]).some(e=>e.points_m.some((v,i)=>i&&segmentDistance(p,e.points_m[i-1],v)<e.width_m/2+radius+.5)))continue;
   if([...(l.chargers??[]),...(l.boarding_points??[])].some(b=>Math.hypot(p[0]-b.center_m[0],p[1]-b.center_m[1])<Math.hypot(...(b.size_m??[3,3]))/2+radius+.5))continue;
   if(placed.some(s=>Math.hypot(p[0]-s.design[0],p[1]-s.design[1])<radius*2+.5))continue;
   // Prefer facing the central apron, with the least displacement from the asset.
   const score=extra*10+Math.hypot(...p)*.01;if(!best||score<best.score)best={p,score};
  }
  if(best)placed.push({id:String(zone.id??zone.marking),kind:zone.kind,role:zone.role,design:best.p,center:rotatePoint(best.p,rotationOf(Number(layout.frame?.heading_deg)||0)),radius});
 }
 return placed;
}

function mesh(){return {positions:[],normals:[],st:[],indices:[]};}
function quad(m,points,uv=[[0,0],[1,0],[1,1],[0,1]]){
 const n=m.positions.length/3,a=points[0],b=points[1],c=points[2],u=b.map((v,i)=>v-a[i]),v=c.map((x,i)=>x-a[i]);
 const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],d=Math.hypot(...normal)||1;
 points.forEach((p,i)=>{m.positions.push(...p);m.normals.push(...normal.map(x=>x/d));m.st.push(...uv[i]);});m.indices.push(n,n+1,n+2,n,n+2,n+3);
}
export function signMesh(signs,heading=0){
 const m=mesh(),turn=rotationOf(heading),columns=Math.max(1,Math.ceil(signs.length/16)),rows=Math.ceil(signs.length/columns);
 signs.forEach((s,index)=>{
  const points=Array.from({length:3},(_,i)=>{const a=i*Math.PI*2/3;const p=rotatePoint([Math.cos(a)*s.radius,Math.sin(a)*s.radius],turn);return [s.center[0]+p[0],s.center[1]+p[1]];});
  const row=Math.floor(index/columns),column=index%columns,u0=column/columns,u1=(column+1)/columns,v0=1-(row+1)/rows,v1=1-row/rows;
  points.forEach((p,i)=>{const q=points[(i+1)%3];quad(m,[[...p,.3],[...q,.3],[...q,1.55],[...p,1.55]],[[u0,v0],[u1,v0],[u1,v1],[u0,v1]]);});
  const solid=Array.from({length:4},()=>[u0+.002/columns,(v0+v1)/2]);
  quad(m,[[...points[0],1.55],[...points[1],1.55],[...points[2],1.55],[...points[2],1.55]],solid);
  for(const p of points){const a=[p[0]-.06,p[1]-.06],b=[p[0]+.06,p[1]-.06],c=[p[0]+.06,p[1]+.06],d=[p[0]-.06,p[1]+.06];const foot=[a,b,c,d];foot.forEach((v,i)=>quad(m,[[...v,0],[...foot[(i+1)%4],0],[...foot[(i+1)%4],.3],[...v,.3]],solid));}
 });return m;
}
function signAtlas(signs,createCanvas){
 const columns=Math.max(1,Math.ceil(signs.length/16)),rows=Math.ceil(signs.length/columns);
 const canvas=createCanvas(256*columns,128*rows),ctx=canvas.getContext('2d');
 signs.forEach((s,i)=>{const x=i%columns*256,y=Math.floor(i/columns)*128;ctx.fillStyle='#121c21';ctx.fillRect(x,y,256,128);ctx.strokeStyle=s.kind==='GATE'?'#f4ce59':'#f4f6ed';ctx.lineWidth=3;ctx.strokeRect(x+3,y+3,250,122);
  ctx.fillStyle=ctx.strokeStyle;ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='600 17px sans-serif';ctx.fillText(s.kind,x+128,y+24);ctx.font='bold 72px sans-serif';ctx.fillText(s.id,x+128,y+78,234);
 });return canvas;
}
function primitive(C,scene,m,matrix,material,id){
 const attr=(values,size,type)=>new C.GeometryAttribute({componentDatatype:type,componentsPerAttribute:size,values});
 return scene.primitives.add(new C.Primitive({geometryInstances:new C.GeometryInstance({id,geometry:new C.Geometry({attributes:{
  position:attr(new Float64Array(m.positions),3,C.ComponentDatatype.DOUBLE),normal:attr(new Float32Array(m.normals),3,C.ComponentDatatype.FLOAT),st:attr(new Float32Array(m.st),2,C.ComponentDatatype.FLOAT)},
  indices:new Uint16Array(m.indices),primitiveType:C.PrimitiveType.TRIANGLES,boundingSphere:C.BoundingSphere.fromVertices(m.positions)})}),
  modelMatrix:matrix,shadows:id.endsWith(':pilot-deck')?C.ShadowMode?.RECEIVE_ONLY:C.ShadowMode?.ENABLED,allowPicking:!id.endsWith(':pilot-deck'),appearance:new C.MaterialAppearance({materialSupport:C.MaterialAppearance.MaterialSupport.TEXTURED,material,flat:true,faceForward:true,translucent:false,closed:false}),asynchronous:false}));
}
// Sub-pixel aggregate fades analytically instead of shimmering at a shallow angle.
const PAVEMENT=`czm_material czm_getMaterial(czm_materialInput i){
 if(imageDimensions.x<=1)discard;
 czm_material m=czm_getDefaultMaterial(i);vec3 base=texture(image,i.st).rgb;
 vec2 p=i.st*metres*160.0;vec2 cell=floor(p);
 float n=fract(sin(dot(cell,vec2(127.1,311.7)))*43758.5453);
 float visible=1.0-smoothstep(0.3,1.4,max(fwidth(p.x),fwidth(p.y)));
 m.diffuse=base*(1.0+(n-0.5)*0.08*visible);m.alpha=1.0;return m;}`;

export class VertiportPilotDetail {
 constructor(C,scene,createCanvas){Object.assign(this,{C,scene,createCanvas});this.records=new Map();this.ready=new Map();this.failed=new Set();this.visible=true;}
 set(id,record,shell,top){this.clear(id);if(shell)this.records.set(id,{record,shell,top});}
 build(id,entry){
  const {C,scene,createCanvas}=this,{record,shell,top}=entry,f=record.layout.frame;
  // At most two close ports, 4096 px each. No high-resolution canvas for distant ports.
  const painted=paintApron(record.layout,record.name,createCanvas,{maxPixels:4096,maxPixelsPerMetre:48});
  const matrix=C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(f.longitude,f.latitude,top+.028));
  // Cesium caches the fabric template and clones it for the next port. A DOM
  // canvas cannot be cloned by that path: bind it after constructing the material.
  // Material updates imageDimensions after the actual texture upload. Until
  // then discard the overlay, retaining the existing apron instead of flashing white.
  const material=new C.Material({translucent:false,fabric:{type:'PilotPavementV4',uniforms:{image:C.Material.DefaultImageId,metres:new C.Cartesian2(painted.width_m,painted.depth_m)},source:PAVEMENT}});
  material.uniforms.image=painted.canvas;
  const cap=shellMesh(shell.points,shell.texture,{rows:[[-1,0],[0,1]],capHeight:0}).cap;
  let deck,sign,signMaterial;
  try {
   deck=primitive(C,scene,cap,matrix,material,`vertiport:${id}:pilot-deck`);const signs=pilotSigns(record.layout);
   if(signs.length){
    signMaterial=new C.Material({translucent:false,fabric:{type:'PilotSignV2',uniforms:{image:C.Material.DefaultImageId},source:'czm_material czm_getMaterial(czm_materialInput i){if(imageDimensions.x<=1)discard;czm_material m=czm_getDefaultMaterial(i);m.diffuse=texture(image,i.st).rgb;m.alpha=1.0;return m;}'}});
    signMaterial.uniforms.image=signAtlas(signs,createCanvas);sign=primitive(C,scene,signMesh(signs,f.heading_deg),matrix,signMaterial,`vertiport:${id}:pilot-signs`);
   }
   return {deck,sign,painted,signs};
  }catch(error){if(deck)scene.primitives.remove(deck);if(sign)scene.primitives.remove(sign);material.destroy();signMaterial?.destroy();throw error;}
 }
 tick(){
  const {C}=this,p=this.scene.camera?.positionWC;if(!p)return;
  const near=this.visible?[...this.records].map(([id,e])=>({id,e,d:C.Cartesian3.distance(p,C.Cartesian3.fromDegrees(e.record.layout.frame.longitude,e.record.layout.frame.latitude,e.top))})).filter(x=>x.d<(this.ready.has(x.id)?850:650)).sort((a,b)=>a.d-b.d).slice(0,2):[];
  const ids=new Set(near.map(x=>x.id));for(const id of this.ready.keys())if(!ids.has(id))this.release(id);
  // Only one upload per tick, so neighbouring pads cannot monopolise one frame.
  const next=near.find(x=>!this.ready.has(x.id)&&!this.failed.has(x.id));
  if(next)try{this.ready.set(next.id,this.build(next.id,next.e));}catch(error){this.failed.add(next.id);console.warn('Vertiport close detail unavailable; base apron retained',next.id,error);}
 }
 release(id){const r=this.ready.get(id);if(r){for(const p of [r.deck,r.sign])if(p){const material=p.appearance?.material;this.scene.primitives.remove(p);if(material&&!material.isDestroyed?.())material.destroy?.();}this.ready.delete(id);}}
 clear(id){this.release(id);this.records.delete(id);this.failed.delete(id);}
 setVisible(v){this.visible=v;if(!v)for(const id of this.ready.keys())this.release(id);}
 destroy(){for(const id of [...this.records.keys()])this.clear(id);}
}
