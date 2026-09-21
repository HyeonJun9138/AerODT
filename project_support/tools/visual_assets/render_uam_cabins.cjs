// Standalone Three/Edge asset QA. Start preview_server.py --port 8914 first.
// This does not start, stop, reload or steer any simulator or operational tab.
const fs=require('node:fs'),path=require('node:path');
const{chromium}=require('../../environment/visual_assets/node_modules/playwright');
const output=path.resolve(__dirname,'../../cockpit_work/assets');
(async()=>{const browser=await chromium.launch({headless:true,channel:'msedge'});try{
 const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[],results=[];
 page.on('pageerror',e=>errors.push(e.message));
 for(const id of ['joby_s4','projectairsim_airtaxi','kp2a','amvlab_evtol','x_57']){
  await page.goto((process.argv[2]||'http://127.0.0.1:8914')+'/uam_cabin_check.html?asset='+id);await page.waitForFunction(()=>window.ready,{timeout:60000});
  for(const [mode,fov] of [['exterior',60],['pilot',60],['left',60],['right',60],['cabin',60],['pilot',35],['pilot',90]]){
   await page.evaluate(([mode,fov])=>window.renderView(mode,fov),[mode,fov]);await page.screenshot({path:path.join(output,id+'_'+mode+(fov===60?'':'_'+fov)+'.png')});
  }
  const geometry=await page.evaluate(()=>{
   const{T,model,meta}=window;
   // Two-sided ray tests prevent backface culling from masquerading as a window.
   model.traverse(o=>{if(o.material)o.material.side=T.DoubleSide});
   const eye=new T.Vector3(...meta.cockpit.eye);
   const trace=direction=>new T.Raycaster(eye,direction).intersectObject(model,true).filter(h=>!h.object.name.startsWith('Cabin_'));
   const forward=trace(new T.Vector3(1,0,0))[0];
   const screens=meta.cockpit.screens.map(s=>{const target=new T.Vector3(...s.center);const h=trace(target.clone().sub(eye).normalize())[0];return{id:s.id,distance:eye.distanceTo(target),shell_distance:h?.distance??null,inside:h&&h.distance>eye.distanceTo(target)}});
   return{eye:meta.cockpit.eye,first_forward_material:forward?.object.material.name,first_forward_distance:forward?.distance,first_forward_transparent:forward?.object.material.transparent,screens};
  });
  if(!geometry.first_forward_transparent||geometry.screens.some(s=>!s.inside))throw new Error(id+': invalid eye/screen shell relation');
  results.push({id,...geometry});console.log(id,'7 rendered views; eye through glass and 3 screen centers inside shell');
 }
 fs.writeFileSync(path.join(output,'render_validation.json'),JSON.stringify({renderer:'Three.js/Edge WebGL (not Cesium or Unreal)',page_errors:errors,results},null,2));
 if(errors.length)throw new Error(errors.join('\n'));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
