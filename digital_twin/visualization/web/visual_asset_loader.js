// Network asset loading belongs to visualization, never to authoritative state.
// Only aircraft in the initial snapshot, one URI per rig. Do not download the
// entire library just because a map was opened. These are temporary warm-up
// models in the MAIN scene; no GPU object is shared with another context.
export function flightShaderModels(assets,items,scaleOf=()=>1) {
  const seen=new Set(),models=[];
  for(const item of items){
    const entity=item.entity;
    if(entity?.kind!=='uam' || !['scenario','physical_uam'].includes(entity.source))continue;
    const base=assets.get(entity.visual_asset_id);
    const asset=base?.flight_visual?{...base,...base.flight_visual}:base;
    if(!asset?.uri || seen.has(asset.uri))continue;
    seen.add(asset.uri);
    models.push({name:`flight:${entity.visual_asset_id}`,url:asset.uri,scale:scaleOf(entity.visual_asset_id),flight:true});
    if(models.length>=6)break;
  }
  return models;
}

// One metre-to-file conversion for every view of a flight rig. Missing or
// invalid measurements preserve authored geometry rather than inventing units.
export function visualModelScale(asset, {flight=false, span}={}) {
  const rig=flight ? asset?.flight_visual : null;
  const measured=rig ? rig.measured_m : asset?.size_m;
  const target=span ?? rig?.size_m;
  return Number.isFinite(measured) && measured>0 && Number.isFinite(target) && target>0
    ? target/measured : 1;
}

// Which file to draw and how big to draw it are one decision, so they are
// answered together and handed back as a pair. A flight rig and the base model
// are different geometry with different extents: a rig drawn at the base
// model's scale is drawn at the wrong size, and every measurement later taken
// off that image - apparent size to range above all - inherits the error. The
// two came apart because two callers each chose one of them with its own
// predicate; there is nothing here for a caller to pick apart.
export function visualModelChoice(asset,{flight=false,span}={}){
  const rig=flight?asset?.flight_visual:null;
  return {uri:rig?.uri??asset?.uri,scale:visualModelScale(asset,{flight,span}),flight:Boolean(rig)};
}

export async function loadImageryProvider(primary, fallback, timeoutMs = 8000) {
  async function bounded(load) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(load),new Promise((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('imagery timeout')),timeoutMs);
      })]);
    } finally {clearTimeout(timer);}
  }
  try { return {provider:await bounded(primary),fallback:false}; }
  catch { return {provider:await bounded(fallback),fallback:true}; }
}
// `scale` draws an acquired model at a size somebody decided on rather than at
// whatever size its author left it. The library's models come in at wildly
// different scales and a few carry no real-world extent at all, so a caller that
// knows how big the thing should be says so. 1 keeps the model as it came.
export async function loadVisualModel(C, asset, id, matrix,timeoutMs=20000,scale=1) {
  let expired=false,timer;
  const drawn=Number.isFinite(scale)&&scale>0?scale:1;
  // No dynamic environment map per aircraft: Cesium would render a six-face
  // cube map around each model and convolve it (a program that measured
  // 1.2 s to compile the first time a UAM appeared, and a re-render whenever a
  // model has moved on). The lighting falls back to the procedural sky and
  // ground, which on an aircraft-sized model reads the same.
  const pending=Promise.resolve(C.Model.fromGltfAsync({url:asset.uri,modelMatrix:matrix,scale:drawn,
    forwardAxis:C.Axis.X,upAxis:C.Axis.Y,environmentMapOptions:{enabled:false},
    minimumPixelSize:0,maximumScale:drawn,id,show:false})).then(model=>{if(expired)model.destroy();return model;});
  try {
    return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{
      expired=true;reject(new Error('model timeout'));
    },timeoutMs);})]);
  } finally {clearTimeout(timer);}
}

// Cesium raises one TileProviderError per failed tile and retries the request
// when a listener asks. Retry what looks transient (no status, 429, 5xx) a
// couple of times; a 404 is a tile that does not exist and stays failed, so
// the ancestor's imagery is drawn instead of asking again.
export function retryTile(error,maximumRetries=2) {
  if(!error || typeof error.timesRetried!=='number' || error.timesRetried>=maximumRetries)return false;
  const status=error.error?.statusCode;
  if(status!==undefined && status!==429 && status<500)return false;
  error.retry=true;
  return true;
}
