// Presentation capabilities only. Runtime remains the owner of all entities.
export const DOMAINS = Object.freeze({
  uam: Object.freeze({id:'uam',label:'UAM',kinds:['uam','aircraft','bird','drone'],sound:true}),
  satellite: Object.freeze({id:'satellite',label:'Satellite',kinds:['satellite'],sound:false}),
});
const SHARED_SOURCES = new Set(['terrain','imagery','clouds','weather']);
export function sourceAllowed(domain,id){
  if(!DOMAINS[domain])return false;
  if(domain==='uam')return !['satellite','celestrak'].includes(id);
  return SHARED_SOURCES.has(id)||['satellite','celestrak'].includes(id);
}
export function scopeSnapshot(snapshot,domain){
  const kinds=DOMAINS[domain]?.kinds??[];
  return {...snapshot,entities:(snapshot.entities??[]).filter(e=>kinds.includes(e.kind)),
    sources:(snapshot.sources??[]).filter(s=>sourceAllowed(domain,s.id))};
}
export function scopeDescription(description,domain){
  const sources=(description.sources??[]).filter(s=>sourceAllowed(domain,s.id));
  const ids=new Set(sources.map(s=>s.id)), groups=new Set(sources.map(s=>s.group));
  return {...description,sources,
    groups:(description.groups??[]).filter(g=>groups.has(g.id)||(domain==='uam'&&g.kind!=='sources')),
    values:Object.fromEntries(Object.entries(description.values??{}).filter(([id])=>ids.has(id))),
    state:(description.state??[]).filter(s=>ids.has(s.id))};
}
// A domain cannot accidentally submit another domain's library settings.
// Choosing a domain never writes shared server collection switches.
export function scopedLibraryApi(api,domain){
  return {
    describe:async()=>scopeDescription(await api.describe(),domain()),
    apply:async patch=>{
      for(const id of Object.keys(patch.sources??{}))if(!sourceAllowed(domain(),id))throw new Error(`현재 도메인에서 사용할 수 없는 설정: ${id}`);
      return scopeDescription(await api.apply(patch),domain());
    },
    exports:()=>{if(domain()!=='uam')throw new Error('UAM 자료 내보내기는 UAM에서만 가능합니다.');return api.exports();},
  };
}
