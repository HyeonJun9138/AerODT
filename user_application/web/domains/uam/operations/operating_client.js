// Keep an already running older server usable during a staged update.
export async function readOperating(read,url){
  try{return await read(url);}catch(error){
    if(error.message!=='HTTP 404')throw error;
    const path=url.replace('/api/operations/context/','');
    if(path==='environment'){
      const [ports,routes,options,revision]=await Promise.all([read('/api/simulation/vertiports'),read('/api/simulation/routes'),read('/api/simulation/routes/options'),read('/api/simulation/revision')]);
      return {...ports,network:routes,segments:options.segments,revision:revision.revision,source:'scenario',read_only:false};
    }
    const legacy={revision:'/api/simulation/revision',decisions:'/api/decisions',profile:'/api/simulation/operating-profile'};
    return read(legacy[path]??'/api/simulation/scenario/'+path);
  }
}
