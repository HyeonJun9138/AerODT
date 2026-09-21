import {LABEL_FADE_MS,labelFadeAlpha} from './label_fade.js';
// Optional reference imagery, independent of aircraft/satellite name labels.
export class PlaceLabels {
  constructor({load,attach,detach=()=>{},onStatus=()=>{},suspended=false,isReady=()=>true,stableMs=0}) {
    Object.assign(this,{load,attach,detach,onStatus,isReady,stableMs});this.enabled=false;this.pending=false;this.disposed=false;
    this.suspended=Boolean(suspended);
  }
  setSuspended(suspended,fadeMs=LABEL_FADE_MS) {
    if(this.disposed)return;
    this.suspended=Boolean(suspended);
    this.fadeDuration=fadeMs;
    this.syncVisibility();
  }
  syncVisibility() {
    if(!this.layer)return;
    const show=this.enabled&&!this.suspended;
    if(show && !this.layer.show){
      // Exact zero can stop Cesium requesting imagery tiles. Warm them almost
      // invisibly before fading so late provider attachment does not pop in.
      this.layer.alpha=.001;this.fading=true;this.waitStart=null;this.fadeStart=null;this.readySince=null;
    }
    this.layer.show=show;
    if(!show){this.layer.alpha=0;this.fading=false;}
  }
  update(now) {
    if(this.disposed || !this.fading || !this.layer?.show)return false;
    this.waitStart??=now;
    if(this.fadeStart===null){
      if(this.isReady())this.readySince??=now;else this.readySince=null;
      if((this.readySince===null || now-this.readySince<this.stableMs) && now-this.waitStart<2500)return true;
      this.fadeStart=now;
    }
    const alpha=labelFadeAlpha(now-this.fadeStart,this.fadeDuration);
    this.layer.alpha=Math.max(.001,alpha);
    if(alpha===1)this.fading=false;
    return true;
  }
  async setEnabled(enabled) {
    if(this.disposed)return;
    this.enabled=Boolean(enabled);
    if(this.enabled && this.layer && this.tileError) {
      this.removeError?.();this.provider=null;this.detach(this.layer);this.layer=null;this.tileError=false;
    }
    if(this.layer){this.syncVisibility();this.onStatus(this.enabled?'ready':'off');return;}
    if(!this.enabled){this.onStatus('off');return;}
    if(this.pending){this.onStatus('loading');return;}
    this.pending=true;this.onStatus('loading');
    try {
      const provider=await this.load();
      if(this.disposed)return;
      this.provider=provider;
      this.removeError=provider.errorEvent?.addEventListener(()=>{
        if(this.disposed || this.provider!==provider)return;
        this.tileError=true;if(this.enabled)this.onStatus('partial');
      });
      this.layer=this.attach(provider);this.layer.aerodtRole='place_labels';
      this.layer.show=false;this.syncVisibility();this.onStatus(this.enabled?'ready':'off');
    } catch {
      if(!this.disposed)this.onStatus(this.enabled?'error':'off');
    } finally {this.pending=false;}
  }
  destroy() {this.disposed=true;this.removeError?.();this.provider=null;}
}
