const REFINED=new Set(['joby_s4','projectairsim_airtaxi','kp2a','amvlab_evtol']);
const IDS=new Set(['joby_s4','projectairsim_airtaxi','kp2a','amvlab_evtol','x_57']);
// Optional metadata hydration supports an already-running pre-cockpit server.
// At most five local reads, without delaying globe startup or restarting flights.
export async function loadCockpitProfiles(catalog,read){
 await Promise.all((catalog.assets??[]).filter(a=>IDS.has(a.asset_id)&&(REFINED.has(a.asset_id)||!a.cockpit?.viewpoints)&&a.metadata_uri?.startsWith('/visual-assets/')).slice(0,5).map(async asset=>{
  try{const meta=await read(asset.metadata_uri),p=meta.cockpit;
   if(p?.schema_version===1&&['eye','forward','up'].every(k=>Array.isArray(p[k])&&p[k].length===3&&p[k].every(Number.isFinite))&&Array.isArray(p.screens)){
    asset.cockpit=p;
    if(asset.flight_visual?.uri&&/^[a-f0-9]{64}$/.test(meta.flight_visual?.sha256??''))asset.flight_visual.uri=(/^[a-z_]+\.glb$/.test(meta.flight_visual.path??'')?asset.metadata_uri.slice(0,asset.metadata_uri.lastIndexOf('/')+1)+meta.flight_visual.path:asset.flight_visual.uri.split('?')[0])+'?v='+meta.flight_visual.sha256;
   }
  }catch{/* A missing optional cabin leaves external tracking available. */}
 }));
}
