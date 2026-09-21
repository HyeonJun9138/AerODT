// Depth is sampled after rendering. The label itself is rendered as one overlay,
// never per-glyph depth-clipped; an obstruction hides the whole label.
export class WholeLabelOcclusion {
 constructor(C,viewer,items,labels=()=>null){Object.assign(this,{C,viewer,items,labels});this.cursor=null;this.suspended=false;this.pending=null;this.clock=()=>performance.now();}
 // Give every name back and forget what was hidden. Used wherever this check
 // stops running, so nothing is left hidden by a test that is no longer made.
 release(){
  this.pending=null;
  for(const item of this.items.values())if(item.labelOccluded){item.labelOccluded=false;item.labelClearCount=0;if(item.label)item.label.show=Boolean(item.label.text);}
 }
 update(now=performance.now(),{moving=false}={}){
  const {C,viewer}=this,scene=viewer.scene;
  // The cockpit puts the whole nameplate collection away rather than each
  // name (cockpit_view.js hideNameplates), and this check only ever looked at
  // the individual labels. So it went on asking the depth buffer where names
  // were that nobody was drawing -- and each question is a readPixels that
  // waits for the pipeline to drain, in the one view that was already slowest.
  const collection=this.labels?.();
  if(collection&&collection.show===false){
   if(!this.suspended){this.suspended=true;this.release();}
   return;
  }
  this.suspended=false;
  if(!scene.pickPositionSupported||!scene.pickPosition||!C.SceneTransforms?.worldToWindowCoordinates||(C.SceneMode&&scene.mode===C.SceneMode.SCENE2D)){
   this.release();
   return;
  }
  // Reading depth synchronizes GPU and CPU. Do not add those stalls to zoom
  // or orbit frames. Preserve last visibility, but discard partial evidence
  // from the old view; normal following translation is not operator motion.
  if(moving){this.pending=null;this.lastSweep=-Infinity;return;}
  // A large overview otherwise probes a different pair of names every frame.
  // Pace new batches at 10 Hz; unfinished budget-limited work still resumes
  // next frame so a slow read does not multiply visibility latency by six.
  if(!this.pending&&now-(this.lastSweep??-Infinity)<100)return;
  if(!this.pending)this.lastSweep=now;
  const started=this.clock();let checked=0,visited=0,reads=0;
  this.cursor??=this.items.entries();
  // A depth read cannot be interrupted once submitted. Check the budget before
  // EACH read, and resume unfinished labels next frame instead of treating an
  // untested corner as clear. Six cheap reads or one slow read, not six stalls.
  while(checked<2&&reads<6&&this.clock()-started<2){
   let work=this.pending;
   if(work&&(this.items.get(work.key)!==work.item||work.item.label!==work.label))this.pending=work=null;
   if(!work){
    if(visited++>=this.items.size)break;
    let next=this.cursor.next();if(next.done){this.cursor=this.items.entries();next=this.cursor.next();if(next.done)break;}
    const [key,item]=next.value,label=item.label;
    if(!label||!label.text||item.entity.kind!=='uam'||item.lod==='hidden'||!item.labelRect||now-(item.occlusionAt??-Infinity)<150)continue;
    work=this.pending={key,item,label,index:0,clear:0,view:null};
   }
   const {item,label}=work;
   if(item.lod==='hidden'||!label.text||!item.labelRect){this.pending=null;continue;}
   checked++;
   const screen=C.SceneTransforms.worldToWindowCoordinates(scene,item.position);if(!screen){this.pending=null;continue;}
   const camera=viewer.camera,origin=camera.positionWC,direction=camera.directionWC;
   const depth=p=>(p.x-origin.x)*direction.x+(p.y-origin.y)*direction.y+(p.z-origin.z)*direction.z;
   const targetDepth=depth(item.position);if(targetDepth<=0){this.pending=null;continue;}
   const {width,height}=item.labelRect,offset=label.pixelOffset??{x:0,y:0};
   let left=screen.x+offset.x-6,right=left+width+12,bottom=screen.y+offset.y+3,top=bottom-height-6;
   // Public Cesium bounds include glyph metrics, background padding and scale.
   if(C.Label?.getScreenSpaceBoundingBox&&label.computeScreenSpacePosition){
    const at=label.computeScreenSpacePosition(scene);
    const rect=at&&C.Label.getScreenSpaceBoundingBox(label,at);
    if(rect&&Number.isFinite(rect.x)&&rect.width>0){left=rect.x;right=rect.x+rect.width;top=rect.y;bottom=rect.y+rect.height;}
   }
   // Account for the model's own skin, not for nearby buildings.
   const margin=Math.max(.75,Math.min(6,(item.model?.ready?item.model.boundingSphere?.radius:1)??1));
   // Invalidate partial evidence after a large view jump or resize, not normal
   // flight/follow motion: that would keep a previously hidden aircraft hidden
   // forever when six samples span several frames. Like the existing 150 ms
   // cadence, a split scan is a temporally sampled visibility approximation.
   const view=[left,right,top,bottom,screen.x,screen.y,targetDepth,margin,
    origin.x,origin.y,origin.z,direction.x,direction.y,direction.z,
    viewer.canvas.clientWidth,viewer.canvas.clientHeight];
   const tolerance=[64,64,64,64,64,64,250,0,250,250,250,.05,.05,.05,0,0];
   if(!work.view||view.some((value,index)=>Math.abs(value-work.view[index])>tolerance[index])){
    work.clear=0;work.view=view;
   }
   const points=[[(left+right)/2,(top+bottom)/2],[left,top],[right,top],[left,bottom],[right,bottom],[screen.x,screen.y]];
   let blocked=false;
   while(work.index<points.length&&reads<6&&this.clock()-started<2){
    const [x,y]=points[work.index++];
    if(x<0||y<0||x>=viewer.canvas.clientWidth||y>=viewer.canvas.clientHeight){work.clear++;continue;}
    reads++;
    let hit;try{hit=scene.pickPosition(new C.Cartesian2(x,y));}catch{work.clear=0;continue;}
    if(hit&&Number.isFinite(hit.x)&&depth(hit)<targetDepth-margin){blocked=true;break;}
    work.clear++;
   }
   if(!blocked&&work.index<points.length)break;
   this.pending=null;item.occlusionAt=now;
   if(blocked){item.labelOccluded=true;item.labelClearCount=0;}
   else if(work.clear===points.length){item.labelClearCount=(item.labelClearCount??0)+1;if(item.labelClearCount>=2||!item.labelOccluded)item.labelOccluded=false;}
   else item.labelClearCount=0;
   label.show=Boolean(label.text)&&!item.labelOccluded;
  }
 }
}
