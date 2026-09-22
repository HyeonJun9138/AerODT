// Rendering only: terrain heights never change authoritative Live Twin state.
// API: start() resolves to the attached provider or null (ellipsoid fallback).
// update(now) retries failed initialization after backoff. ready means provider
// attached, NOT that the current camera's terrain tiles have finished loading.
// Feed globe tile progress into setTilesLoading() for status, not a global
// building visibility gate. Footprints sample their own ground. The Viewer owns
// attached terrain and its tile cache; destroy() releases listeners/references.
import {retryTile} from './visual_asset_loader.js';

export class TerrainLayer {
  constructor({load,attach,onStatus=()=>{},clock=()=>performance.now()}) {
    Object.assign(this,{load,attach,onStatus,clock});
    this.provider=null;this.pending=null;this.controller=null;
    this.retryAt=0;this.failures=0;this.disposed=false;this.unavailable=false;
    this.tilesLoading=false;this.tileError=false;this.removeError=null;
  }
  get ready() {return !this.disposed && this.provider!==null;}
  status(value) {
    if(!this.disposed && this.lastStatus!==value){this.lastStatus=value;this.onStatus(value);}
  }
  applyStatus() {
    if(this.provider)this.status(this.tileError?'error':this.tilesLoading?'streaming':'ready');
  }
  start(now=this.clock()) {
    if(this.disposed || this.unavailable)return Promise.resolve(null);
    if(this.pending)return this.pending;
    if(this.provider)return Promise.resolve(this.provider);
    if(now<this.retryAt)return Promise.resolve(null);
    this.controller=new AbortController();
    const signal=this.controller.signal;
    this.status('loading');
    this.pending=Promise.resolve().then(()=>this.load({signal})).then(provider=>{
      if(this.disposed){provider?.destroy?.();return null;}
      if(!provider)throw new Error('Terrain provider unavailable');
      try {this.attach(provider);} catch(error) {provider.destroy?.();throw error;}
      this.provider=provider;this.failures=0;
      this.removeError=provider.errorEvent?.addEventListener(error=>{
        // A transient failure is asked again before it counts as an error.
        if(retryTile(error))return;
        // Keep already loaded terrain; never log a credential-bearing tile URL.
        this.tileError=true;this.applyStatus();
      });
      this.applyStatus();
      return provider;
    }).catch(error=>{
      if(this.disposed)return null;
      this.unavailable=error?.disabled===true;
      this.retryAt=this.clock()+Math.min(60000*2**this.failures++,300000);
      this.status(this.unavailable?'unavailable':'error');
      return null;
    }).finally(()=>{this.pending=null;this.controller=null;});
    return this.pending;
  }
  update(now=this.clock()) {
    if(!this.disposed && !this.provider && !this.pending && !this.unavailable)this.start(now);
  }
  setTilesLoading(loading) {
    if(this.disposed)return;
    // A tile error remains visible until a subsequent loading cycle finishes.
    if(loading && !this.tilesLoading)this.tileError=false;
    this.tilesLoading=Boolean(loading);this.applyStatus();
  }
  destroy() {
    if(this.disposed)return;
    this.disposed=true;this.controller?.abort();
    this.removeError?.();this.removeError=null;this.provider=null;
  }
}

export const TERRAIN_SCREEN_SPACE_ERROR=2;

// Detail allowed while an approach is at progress t (0..1, eased). Full detail
// at the click, so nothing blurs on the spot; coarser through the fast middle,
// where fine tiles for ground the camera is only passing over would arrive
// late and pop; back to full detail before the landing so the destination is
// already refining as the camera settles, the way dynamic screen-space error
// works for 3D Tiles.
export function motionScreenSpaceError(t) {
  const ease=x=>x*x*(3-2*x),clamp=x=>Math.max(0,Math.min(1,x));
  const rise=ease(clamp(t/.2)),fall=1-ease(clamp((t-.5)/.35));
  return TERRAIN_SCREEN_SPACE_ERROR+8*Math.min(rise,fall);
}

export function configureTerrainStreaming(globe) {
  // Cesium's view-dependent cache is a soft tile count: tiles required for the
  // current frame may exceed it. Close-up work keeps a few hundred tiles in
  // view and following an object pans every frame, so a 100-tile cache evicts
  // what just left the screen and downloads it again on the way back. 400
  // tiles is roughly 60-100 MB with draped imagery. Do not preload invisible
  // sibling terrain.
  globe.tileCacheSize=400;
  globe.maximumScreenSpaceError=TERRAIN_SCREEN_SPACE_ERROR;
  globe.loadingDescendantLimit=20;
  globe.preloadSiblings=false;
  globe.depthTestAgainstTerrain=true;
  configureTileLoadSlice(globe);
}

export function configureTileLoadSlice(globe){
  // Cesium 1.143's endFrame queue services terrain AND imagery. Its default
  // 5ms slice is additional to drawing. No public scheduling option exists;
  // isolate this guarded compatibility setting here (see streaming ADR).
  // This is a soft budget: a single texture upload cannot be preempted.
  const surface=globe?._surface;
  if(Number.isFinite(surface?._loadQueueTimeSlice)&&surface._loadQueueTimeSlice>1)
    surface._loadQueueTimeSlice=1;
}

// Bound tile work before the browser's transport queue; leave relay capacity
// for live APIs and aircraft assets. Direct provider hosts have their own cap.
export function configureRequestBudget(scheduler,origin=globalThis.location?.origin) {
  if(!scheduler)return;
  scheduler.maximumRequestsPerServer=18;
  scheduler.maximumRequests=48;
  // The dashboard relay is HTTP/1.1. Queueing 32 tiles there fills the browser's
  // six connections ahead of selected GLBs and API responses. Keep two free;
  // provider HTTP/2 hosts still use Cesium's ordinary per-server concurrency.
  if(origin){
    const url=new URL(origin);
    const key=`${url.hostname}:${url.port||(url.protocol==='https:'?'443':'80')}`;
    (scheduler.requestsByServer??={})[key]=4;
  }
}

export async function loadWorldTerrain(C,{signal,timeoutMs=25000}={}) {
  if(signal?.aborted)throw new Error('Terrain load cancelled');
  configureRequestBudget(C.RequestScheduler);
  const controller=new AbortController();
  let expired=false,timer,rejectCancelled;
  const cancelled=new Promise((_,reject)=>{rejectCancelled=reject;});
  const cancel=()=>{
    expired=true;controller.abort();rejectCancelled(new Error('Terrain load cancelled'));
  };
  signal?.addEventListener('abort',cancel,{once:true});
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
    expired=true;controller.abort();reject(new Error('Terrain load timeout'));
  },timeoutMs);});
  const pending=(async()=>{
    const url='/api/visualization/terrain/endpoint';
    const response=await fetch(url,{cache:'no-store',signal:controller.signal});
    if(!response.ok){
      const error=new Error('Terrain provider unavailable');
      error.disabled=response.status===404;throw error;
    }
    const endpoint=await response.json();
    if(expired)return null;
    // The endpoint holds only an asset-scoped temporary token. IonResource
    // preserves attribution and refreshes HTTP 401 through our same-origin URL.
    const resource=new C.IonResource(endpoint,new C.Resource({url}));
    const provider=await C.CesiumTerrainProvider.fromUrl(resource,{
      requestVertexNormals:true,requestWaterMask:false
    });
    // Cesium's metadata loader has no public AbortSignal API. A late result
    // must never attach after timeout/disposal; no private Cesium state is used.
    if(expired){provider.destroy?.();return null;}
    return provider;
  })();
  try {return await Promise.race([pending,timeout,cancelled]);}
  finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
