// Browser-local presentation budgets. These never alter source data or the
// authoritative simulation clock, aircraft motion, routes, or collision geometry.
export const PERFORMANCE_PRESETS = {
  balanced: {targetFps:60,maxModels:40,modelLoads:2,terrainError:2,terrainCache:768,
    buildingFetches:4,detailDistance:8000,hybridDistance:1500,fog:1,motionFloor:.7,annotationHz:30},
  quality: {targetFps:60,maxModels:96,modelLoads:3,terrainError:1.5,terrainCache:1536,
    buildingFetches:6,detailDistance:8000,hybridDistance:2500,fog:.75,motionFloor:.85,annotationHz:60},
  fleet: {targetFps:60,maxModels:24,modelLoads:1,terrainError:2,terrainCache:512,
    buildingFetches:3,detailDistance:4000,hybridDistance:1000,fog:1.25,motionFloor:.7,annotationHz:20},
};
export const PERFORMANCE_LIMITS={targetFps:[30,60,5],maxModels:[8,160,8],modelLoads:[1,6,1],
  terrainError:[1,4,.5],terrainCache:[256,2048,128],buildingFetches:[1,8,1],
  detailDistance:[1000,8000,500],hybridDistance:[500,4000,250],fog:[0,1.5,.25],motionFloor:[.6,1,.05],annotationHz:[15,60,5]};
export function performanceProfile(input={}) {
  if(!input||typeof input!=='object')input={};
  const preset=Object.hasOwn(PERFORMANCE_PRESETS,input.preset)?input.preset:input.preset==='custom'?'custom':'balanced';
  const defaults=PERFORMANCE_PRESETS[preset]??PERFORMANCE_PRESETS.balanced;
  const result={preset};
  for(const [key,[min,max,step]] of Object.entries(PERFORMANCE_LIMITS)){
    const raw=input[key],n=raw===null||(typeof raw==='string'&&!raw.trim())?NaN:Number(raw);
    result[key]=Number.isFinite(n)?Number((Math.max(min,Math.min(max,Math.round((n-min)/step)*step+min))).toFixed(4)):defaults[key];
  }
  return result;
}
export function layerBudgets(profile) {
  const p=performanceProfile(profile);
  return {entities:{maxModels:p.maxModels,maxResidentModels:Math.min(256,p.maxModels*2),
    modelCacheSeconds:20,modelLoads:p.modelLoads,movingModelLoads:1,rotorMinPixels:12},
  buildings:{fetches:p.buildingFetches,builds:1,retainedCells:p.terrainCache>=1024?96:64},
  vertiports:{detailDistance:p.detailDistance}};
}
