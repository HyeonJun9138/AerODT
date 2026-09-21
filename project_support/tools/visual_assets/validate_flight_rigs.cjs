// Flight-only validation never overwrites source-model verification.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../..');
const validator=require(path.join(root,'project_support/environment/visual_assets/node_modules/gltf-validator'));
async function main(){
  const results=[];
  for(const id of ['joby_s4','kp2a','amvlab_evtol','x_57']){
    const dir=path.join(root,'digital_twin/model_library/visual_assets/aircraft/civilian',id);
    const metaPath=path.join(dir,'asset.json'),meta=JSON.parse(fs.readFileSync(metaPath));
    const source=fs.readFileSync(path.join(dir,'model.glb')),bytes=fs.readFileSync(path.join(dir,'flight_model.glb'));
    const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
    if(sha(source)!==meta.model.sha256 || sha(bytes)!==meta.flight_visual.sha256)throw Error(id+': stale hash');
    const report=await validator.validateBytes(new Uint8Array(bytes),{maxIssues:1000});
    results.push({id,sha256:sha(bytes),bytes:bytes.length,issues:report.issues});
    meta.flight_visual.validation=report.issues.numErrors?'failed':'gltf-passed';
    fs.writeFileSync(metaPath,JSON.stringify(meta,null,2)+'\n');
    console.log(id,report.issues.numErrors+' errors',report.issues.numWarnings+' warnings');
  }
  const output=path.join(root,'data/workspace/visual_assets/flight_validation.json');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(results,null,2));
  if(results.some(r=>r.issues.numErrors))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
