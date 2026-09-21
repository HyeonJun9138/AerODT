import {buildingTileOptions} from './building_streaming.js';
// Rendering lifecycle only. Geometry is not a Live Twin observation.
export class BuildingLayer {
  constructor({load,attach,onStatus=()=>{},nearMetres=20000,farMetres=25000,retentionMs=15000}) {
    Object.assign(this,{load,attach,onStatus,nearMetres,farMetres,retentionMs});
    this.enabled=true;this.near=false;this.pending=false;this.tileset=null;
    this.retryAt=0;this.disposed=false;this.unavailable=false;this.surfaceReady=true;this.now=0;this.hiddenAt=null;this.trimmed=false;
  }
  status(value) {if(this.lastStatus!==value){this.lastStatus=value;this.onStatus(value);}}
  setEnabled(enabled) {this.enabled=enabled;this.apply();}
  setSurfaceReady(ready) {this.surfaceReady=Boolean(ready);this.apply();}
  apply() {
    const visible=this.enabled && this.near && this.surfaceReady;
    if(this.tileset){
      // A brief orbital overview must not evict the city just loaded for the
      // return. Explicitly disabling a provider still releases it immediately;
      // sustained distant viewing trims once after a short retention interval.
      if(visible){this.hiddenAt=null;this.trimmed=false;}
      else if(!this.enabled||!this.near){
        this.hiddenAt??=this.now;
        if(!this.trimmed&&(!this.enabled||this.now-this.hiddenAt>=this.retentionMs)){
          this.tileset.trimLoadedTiles?.();this.trimmed=true;
        }
      }
      this.tileset.show=visible;
    }
    this.status(!this.enabled?'off':!this.near?'distant':!this.surfaceReady?'terrain':this.tileset?'ready':this.pending?'loading':this.unavailable?'unavailable':'waiting');
  }
  update(altitude,now=performance.now()) {
    if(this.disposed)return;
    this.now=now;
    this.near=Number.isFinite(altitude) && altitude<(this.near?this.farMetres:this.nearMetres);
    this.apply();
    if(!this.enabled || !this.near || !this.surfaceReady || this.tileset || this.pending || this.unavailable)return;
    if(now<this.retryAt){this.status('error');return;}
    this.pending=true;this.status('loading');
    this.load().then(tiles=>{
      if(this.disposed){tiles.destroy?.();return;}
      try {this.attach(tiles);} catch(error) {tiles.destroy?.();throw error;}
      this.tileset=tiles;this.apply();
    }).catch(error=>{
      this.unavailable=error?.disabled===true;this.retryAt=now+60000;
      this.status(this.unavailable?'unavailable':'error');
    }).finally(()=>{this.pending=false;});
  }
  destroy() {this.disposed=true;}
}

export async function loadOsmBuildings(C) {
  const url='/api/visualization/buildings/endpoint';
  const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(18000)});
  if(!response.ok){const error=new Error('Building provider unavailable');error.disabled=response.status===404;throw error;}
  const endpoint=await response.json();
  // IonResource owns the asset-scoped temporary token, credits and 401 refresh.
  // The account token is never sent to this browser.
  const resource=new C.IonResource(endpoint,new C.Resource({url}));
  let expired=false,timer;
  // Following an object moves the camera every frame; with request culling
  // while moving, building tiles would only be fetched once the pursuit
  // stopped. The larger cache keeps a city's worth of tiles across a pursuit.
  const pending=C.Cesium3DTileset.fromUrl(resource,buildingTileOptions(C)).then(tiles=>{if(expired)tiles.destroy();return tiles;});
  try {
    return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Building load timeout'));},20000);})]);
  } finally {clearTimeout(timer);}
}
