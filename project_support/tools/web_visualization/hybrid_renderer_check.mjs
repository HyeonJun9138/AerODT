// Read-only local Edge/WebGL verification against the deployed server. All
// write methods are blocked; camera, provider and display samples are changed
// only inside this disposable page. No fabricated tile metadata is installed.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const options={url:'http://127.0.0.1:18766/?diagnostics',output:path.join(root,'data/workspace/visualization_checks/2026_09_11_optimization/hybrid_renderer.json'),
  browser:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',duration:24000};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i].replace(/^--/,'');if(!(key in options)||!process.argv[i+1])throw new Error('Unknown or missing argument');options[key]=key==='duration'?Number(process.argv[i+1]):process.argv[i+1];}
if(!Number.isFinite(options.duration)||options.duration<1000||options.duration>120000)throw new Error('Duration must be 1000–120000 ms');
const url=new URL(options.url);if(url.username||url.password)throw new Error('Embedded credentials are not supported');
const {chromium}=await import(pathToFileURL(path.resolve(path.dirname(process.execPath),'../node_modules/playwright/index.mjs')).href);
const report={createdAt:new Date().toISOString(),scope:'LOCAL isolated headless Edge WebGL visual QA, not remote desktop FPS',backendWritesSent:0,
  blockedWrites:0,localAppearanceOverride:{quality:'balanced',opacity:.9,distance:'city',tint:'neutral',brightness:1},pageErrors:[],consoleErrors:[],metadataResponses:[],phases:[]};
const clean=value=>String(value).replace(/https?:\/\/[^\s"'<>]+/g,match=>{try{const u=new URL(match);return u.origin+u.pathname;}catch{return '[url]';}}).slice(0,500);
await mkdir(path.dirname(options.output),{recursive:true});
const browser=await chromium.launch({executablePath:options.browser,headless:true,args:['--no-first-run','--no-default-browser-check']});
try{
  const context=await browser.newContext({viewport:{width:1600,height:900},deviceScaleFactor:1,reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',async route=>{if(!['GET','HEAD','OPTIONS'].includes(route.request().method())){report.blockedWrites++;await route.fulfill({status:204,body:''});}else await route.continue();});
  const page=await context.newPage();
  page.on('pageerror',error=>{if(report.pageErrors.length<20)report.pageErrors.push(clean(error.message));});
  page.on('console',message=>{if(message.type()==='error'&&report.consoleErrors.length<30)report.consoleErrors.push(clean(message.text()));});
  page.on('response',async response=>{
    const pathname=new URL(response.url()).pathname;
    if(!pathname.includes('/vworld/3d/')||!pathname.endsWith('.json')||report.metadataResponses.length>=24)return;
    try{
      const data=await response.json();let geometryNodes=0,annotatedNodes=0;
      function walk(tile){if(!tile)return;if(/\.b3dm(?:\?|$)/i.test(tile.content?.uri??''))geometryNodes++;if(tile.extras?.aerodtCoverageRegion)annotatedNodes++;for(const child of tile.children??[])walk(child);}
      walk(data.root);report.metadataResponses.push({path:pathname,status:response.status(),geometryNodes,annotatedNodes});
    }catch{}
  });
  await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>globalThis.aerodtDiagnostics?.client&&globalThis.aerodtDiagnostics?.globe?.hybridBuildings&&
    document.getElementById('loading')?.hidden===true&&!globalThis.aerodtDiagnostics.globe.entryActive&&
    !globalThis.aerodtDiagnostics.globe.transitioning,null,{timeout:60000});
  await page.evaluate(()=>{
    const d=globalThis.aerodtDiagnostics,g=d.globe;d.client.setPaused(true);g.stopTracking();
    g.entityScene.replace({epoch:(Number(g.entityScene.samples.epoch)||0)+1,sequence:1,state_time:1000,clock_rate:0,entities:[]});
    g.setPerformanceOptions({preset:'balanced'});g.setTerrainEnabled(true);g.setBuildingsProvider('vworld_hybrid');g.setBuildingsEnabled(true);
    g.setBuildingAppearance({quality:'balanced',opacity:.9,distance:'city',tint:'neutral',brightness:1});
    globalThis.hybridQa={frames:[],coverageFrames:[],previous:0};g.viewer.scene.postRender.addEventListener(()=>{
      const t=performance.now(),p=globalThis.hybridQa;if(p.previous)p.frames.push(t-p.previous);p.previous=t;
      p.coverageFrames.push(g.hybridBuildings.stats.visibleRegions);
    });
    g.viewer.scene.renderError.addEventListener((scene,error)=>{globalThis.hybridQa.error=String(error);});
  });
  for(const phase of [
    {name:'jung_hybrid_near',longitude:126.978,latitude:37.560,height:650,heading:0,pitch:-45,distance:1500},
    {name:'yeouido_hybrid_switch',longitude:126.925,latitude:37.514,height:650,heading:0,pitch:-45,distance:1500},
    {name:'jung_hybrid_revisit',longitude:126.978,latitude:37.560,height:800,heading:0,pitch:-45,distance:1000},
  ]){
    const item={...phase,samples:[]};report.phases.push(item);console.log(JSON.stringify({event:'phase',name:phase.name}));
    await page.evaluate(phase=>{
      const g=globalThis.aerodtDiagnostics.globe,C=globalThis.Cesium;
      g.setPerformanceOptions({...g.performanceOptions,preset:'custom',hybridDistance:phase.distance});
      g.motion.cancel();g.stopTracking();g.viewer.camera.cancelFlight();
      g.viewer.camera.setView({destination:C.Cartesian3.fromDegrees(phase.longitude,phase.latitude,phase.height),orientation:{heading:C.Math.toRadians(phase.heading),pitch:C.Math.toRadians(phase.pitch),roll:0}});
      globalThis.hybridQa.frames=[];globalThis.hybridQa.coverageFrames=[];globalThis.hybridQa.previous=0;g.viewer.scene.requestRender();
    },phase);
    const start=Date.now();
    while(Date.now()-start<options.duration){
      await new Promise(resolve=>setTimeout(resolve,500));
      item.samples.push(await page.evaluate(()=>{
        const g=globalThis.aerodtDiagnostics.globe,t=g.vworld3d?.tileset,C=globalThis.Cesium,c=g.viewer.camera,p=c.positionCartographic;
        return {at:performance.now(),hybrid:g.hybridBuildings.stats,plain:g.vworldBuildings.stats,native:{show:t?.show??false,bytes:t?.totalMemoryUsageInBytes??0,tilesLoaded:t?.tilesLoaded??false},
          camera:{longitude:C.Math.toDegrees(p.longitude),latitude:C.Math.toDegrees(p.latitude),height:p.height,pitch:C.Math.toDegrees(c.pitch),entryActive:g.entryActive},
          clipMetres:g.vworld3dFocus?.planes?.get(0)?.distance??null,terrain:{ready:g.terrain?.ready??false,flat:g.terrainFlat,source:g.activeTerrainSource},renderError:globalThis.hybridQa.error??null};
      }));
      const camera=item.samples.at(-1).camera;
      if(Math.abs(camera.height-phase.height)>5||Math.abs(camera.longitude-phase.longitude)>.0001||Math.abs(camera.latitude-phase.latitude)>.0001||Math.abs(camera.pitch-phase.pitch)>.5||camera.entryActive){
        item.invalidCamera=camera;throw new Error(`Requested near camera was overwritten in ${phase.name}`);
      }
    }
    item.frameIntervals=await page.evaluate(()=>{const f=globalThis.hybridQa.frames.slice().sort((a,b)=>a-b);return {count:f.length,p50Ms:f[Math.floor(f.length*.5)]??null,p95Ms:f[Math.ceil(f.length*.95)-1]??null,maxMs:f.at(-1)??null};});
    item.postRenderCoverage=await page.evaluate(()=>{const f=globalThis.hybridQa.coverageFrames;return {frames:f.length,withPhotoRegions:f.filter(n=>n>0).length,maximumRegions:Math.max(0,...f),lastRegions:f.at(-1)??0};});
    item.screenshot=path.join(path.dirname(options.output),phase.name+'.png');await page.screenshot({path:item.screenshot});
  }
  report.finishedAt=new Date().toISOString();
}catch(error){report.error=clean(error.stack??error);process.exitCode=1;}finally{await browser.close();await writeFile(options.output,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({event:'complete',output:options.output,error:report.error??null}));
