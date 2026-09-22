// Rendering adapter: local ellipsoidal heights replace world terrain only in
// covered tiles. No authoritative asset/flight altitude is modified here.
import {yieldTerrainWork} from './terrain_work_yield.js';
export function intersectsBounds(rect, bounds) {
  const degrees=180/Math.PI;
  return bounds.some(([w,s,e,n])=>w<=rect.east*degrees && e>=rect.west*degrees &&
    s<=rect.north*degrees && n>=rect.south*degrees);
}

function heightTileWork(C, original, rectangle, buffer, size, childTileMask, credit) {
  const count=size*size;
  if(buffer.byteLength!==count*8)throw new Error('Invalid local terrain payload');
  const wire=new DataView(buffer),heights=new Float32Array(count);
  const sample = i => {
    const h=wire.getFloat32(i*4,true),weight=wire.getFloat32((count+i)*4,true);
    if(!Number.isFinite(h) || !Number.isFinite(weight) || weight<0 || weight>1)throw new Error('Invalid local height');
    let world=0;
    if(weight<1) {
      const col=i%size,row=Math.floor(i/size);
      world=original?.interpolateHeight(rectangle,rectangle.west+(rectangle.east-rectangle.west)*col/(size-1),
        rectangle.north-(rectangle.north-rectangle.south)*row/(size-1));
      if(!Number.isFinite(world))throw new Error('World terrain interpolation unavailable');
    }
    heights[i]=weight*h+(1-weight)*world;
    return weight<1;
  };
  return {count,sample,finish:()=>new C.HeightmapTerrainData({buffer:heights,width:size,height:size,childTileMask,credits:credit?[credit]:[]})};
}

export function mergeHeightTile(C, original, rectangle, buffer, size, childTileMask, credit) {
  const work=heightTileWork(C,original,rectangle,buffer,size,childTileMask,credit);
  for(let i=0;i<work.count;i++)work.sample(i);
  return work.finish();
}

export async function mergeHeightTileSliced(C, original, rectangle, buffer, size, childTileMask, credit,
    {yieldWork=yieldTerrainWork,cancelled=()=>false,now=()=>performance.now()}={}) {
  const work=heightTileWork(C,original,rectangle,buffer,size,childTileMask,credit);
  let i=0;
  while(i<work.count) {
    if(cancelled())throw new Error('Terrain request cancelled');
    await yieldWork();
    if(cancelled())throw new Error('Terrain request cancelled');
    const start=now();let interpolated=0;
    // Fully covered pixels are cheap: don't make an interior tile wait 17
    // frames merely to copy heights. Bound expensive world-mesh samples and
    // elapsed CPU time while retaining all 65x65 source values.
    do {if(work.sample(i++))interpolated++;} while(i<work.count && interpolated<256 && now()-start<2);
  }
  return work.finish();
}

export class LocalTerrainProvider {
  constructor(C,world,metadata,{fetchTile,onFallback=()=>{},source='local',yieldWork=yieldTerrainWork}={}) {
    if(!['local','conditioned'].includes(source))throw new Error('Unknown terrain source');
    this.C=C;this.world=world;this.metadata=metadata;this.onFallback=onFallback;
    this.yieldWork=yieldWork;
    this.tilingScheme=world.tilingScheme;this.errorEvent=world.errorEvent;this.credit=world.credit;
    this.hasWaterMask=false;this.hasVertexNormals=false;this.pending=0;
    this.localCredit=C.Credit?new C.Credit(metadata.credit):null;
    this.fetchTile=fetchTile ?? ((x,y,level)=>{
      const request=new C.Request({throttle:true,throttleByServer:true,type:C.RequestType.TERRAIN});
      return new C.Resource({url:`/api/visualization/terrain/${source}/${level}/${x}/${y}?v=${encodeURIComponent(metadata.version)}`,request}).fetchArrayBuffer();
    });
    const base=world.availability;
    this.availability=base ? {
      computeMaximumLevelAtPosition:position=>{
        const tile=this.tilingScheme.positionToTileXY(position,metadata.max_level);
        return tile && this.covers(tile.x,tile.y,metadata.max_level) ? metadata.max_level : base.computeMaximumLevelAtPosition(position);
      },
      isTileAvailable:(level,x,y)=>this.getTileDataAvailable(x,y,level),
      computeBestAvailableLevelOverRectangle:rect=>base.computeBestAvailableLevelOverRectangle(rect)
    } : undefined;
  }
  covers(x,y,level) {return intersectsBounds(this.tilingScheme.tileXYToRectangle(x,y,level),this.metadata.bounds);}
  getLevelMaximumGeometricError(level) {
    // A 65x65 local mesh must not inherit a smaller quantized-mesh error budget.
    const local=this.C.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      this.tilingScheme.ellipsoid,this.metadata.width,this.tilingScheme.getNumberOfXTilesAtLevel(0))/2**level;
    return Math.max(local,this.world.getLevelMaximumGeometricError(level));
  }
  getTileDataAvailable(x,y,level) {
    if(level>=this.metadata.min_level && this.covers(x,y,level))return level<=this.metadata.max_level;
    return this.world.getTileDataAvailable(x,y,level);
  }
  loadTileDataAvailability(x,y,level) {
    if(level>=this.metadata.min_level && this.covers(x,y,level))return undefined;
    return this.world.loadTileDataAvailability?.(x,y,level);
  }
  requestTileGeometry(x,y,level,request) {
    const {min_level:min,max_level:max,width:size}=this.metadata;
    if(level<min || level>max || !this.covers(x,y,level))return this.world.requestTileGeometry(x,y,level,request);
    if(this.pending>=6)return undefined;
    const local=this.fetchTile(x,y,level);
    if(local===undefined)return undefined; // Cesium scheduler retries throttled work.
    this.pending++;
    const getWorld=()=>{
      // A cancelled view request must not be repurposed for sampling fallback.
      if(request?.cancelled)throw new Error('Terrain request cancelled');
      return this.world.requestTileGeometry(x,y,level);
    };
    return Promise.resolve(local).then(async buffer=>{
      if(!buffer)throw new Error('Local terrain unavailable');
      const view=new DataView(buffer),count=size*size;
      if(buffer.byteLength!==count*8)throw new Error('Invalid local terrain payload');
      let needsWorld=false;
      for(let i=0;i<count;i++)if(view.getFloat32((count+i)*4,true)<1){needsWorld=true;break;}
      const original=needsWorld?await getWorld():null;
      let mask=0;
      // Cesium bit order: SW=1, SE=2, NW=4, NE=8.
      for(const [dx,dy,bit] of [[0,1,1],[1,1,2],[0,0,4],[1,0,8]])
        if(this.getTileDataAvailable(x*2+dx,y*2+dy,level+1)!==false)mask|=bit;
      return mergeHeightTileSliced(this.C,original,this.tilingScheme.tileXYToRectangle(x,y,level),buffer,size,mask,this.localCredit,
        {yieldWork:this.yieldWork,cancelled:()=>Boolean(request?.cancelled)});
    }).catch(async error=>{
      if(request?.cancelled)throw error;
      this.onFallback();
      const fallback=await getWorld();
      if(!fallback)throw new Error('Terrain temporarily unavailable');
      return fallback;
    }).finally(()=>{this.pending--;});
  }
}

export async function loadLocalTerrain(C,world,{signal,onFallback,source='local'}={}) {
  if(!['local','conditioned'].includes(source))throw new Error('Unknown terrain source');
  const controller=new AbortController();
  const abort=()=>controller.abort();
  if(signal?.aborted)abort();
  else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,10000);
  try {
  const response=await fetch(`/api/visualization/terrain/${source}`,{signal:controller.signal,cache:'no-store'});
  if(!response.ok)throw new Error('Local DEM not configured');
  const meta=await response.json();
  if(!meta.enabled || meta.schema_version!==1 || meta.width!==65 || meta.height!==65 ||
    meta.min_level!==6 || meta.max_level!==14 || !Array.isArray(meta.bounds) || !meta.bounds.length ||
    meta.bounds.some(b=>!Array.isArray(b)||b.length!==4||b.some(v=>!Number.isFinite(v))))throw new Error('Local DEM unavailable');
  return new LocalTerrainProvider(C,world,meta,{onFallback,source});
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
  }
}
