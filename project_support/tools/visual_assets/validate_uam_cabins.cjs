// Validate cabins without replacing source-model or live-flight evidence.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
const validator=require(path.join(root,'project_support/environment/visual_assets/node_modules/gltf-validator'));
(async()=>{const results=[];for(const id of ['joby_s4','projectairsim_airtaxi','kp2a','amvlab_evtol','x_57']){
 const directory=path.join(root,'digital_twin/model_library/visual_assets/aircraft/civilian',id),file=path.join(directory,'asset.json');const meta=JSON.parse(fs.readFileSync(file));
 const report=await validator.validateBytes(new Uint8Array(fs.readFileSync(path.join(directory,meta.flight_visual.path))),{maxIssues:1000});
 results.push({id,issues:report.issues});meta.flight_visual.validation=report.issues.numErrors?'failed':'gltf-passed';fs.writeFileSync(file,JSON.stringify(meta,null,2)+'\n');
 console.log(id,report.issues.numErrors+' errors',report.issues.numWarnings+' warnings');}
 fs.writeFileSync(path.join(root,'project_support/cockpit_work/assets/gltf_validation.json'),JSON.stringify(results,null,2));if(results.some(r=>r.issues.numErrors))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
