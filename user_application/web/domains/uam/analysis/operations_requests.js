// One read per URL across summary/detail windows; no retained result cache.
export function createAnalysisReader(readJSON){
  const pending=new Map();
  return url=>{
    if(pending.has(url))return pending.get(url);
    const promise=(async()=>readJSON(url,{timeoutMs:30000}))();
    pending.set(url,promise);
    const clear=()=>{if(pending.get(url)===promise)pending.delete(url);};
    promise.then(clear,clear);
    return promise;
  };
}
