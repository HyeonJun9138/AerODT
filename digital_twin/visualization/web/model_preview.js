import {loadVisualModel} from './visual_asset_loader.js';
import {releaseWidgetContext} from './webgl_release.js';

// One optional inspection renderer. It has no terrain, feeds or runtime state.
export class ModelPreview {
  constructor(C,container,onStatus=()=>{},{loadModel=loadVisualModel,creditContainer=undefined}={}) {
    Object.assign(this,{C,container,onStatus,loadModel,creditContainer});this.generation=0;this.assetId=null;
  }
  // The page already shows the engine and provider credits once, in the footer.
  // A second logo inside a model thumbnail adds no attribution, so the widget
  // writes into that same shared area when the caller supplies it.
  widgetOptions() {
    return {globe:false,skyBox:false,skyAtmosphere:false,baseLayer:false,scene3DOnly:true,
      shouldAnimate:false,targetFrameRate:30,requestRenderMode:true,maximumRenderTimeChange:Infinity,
      showRenderLoopErrors:false,creditContainer:this.creditContainer};
  }
  async show(asset) {
    if(!asset?.uri?.startsWith('/visual-assets/')){this.close();this.onStatus('unavailable');return;}
    if(this.assetId===asset.asset_id)return;
    this.close();this.assetId=asset.asset_id;const generation=this.generation,C=this.C;
    this.onStatus('loading');let model,attached=false;
    try {
      const origin=C.Cartesian3.fromDegrees(0,0,0),matrix=C.Transforms.eastNorthUpToFixedFrame(origin);
      model=await this.loadModel(C,asset,'asset-preview',matrix);
      if(generation!==this.generation){model.destroy();return;}
      const widget=this.widget=new C.CesiumWidget(this.container,this.widgetOptions());
      const scene=widget.scene;scene.backgroundColor=C.Color.fromCssColorString('#0d1c25');
      scene.screenSpaceCameraController.enableInputs=false;
      scene.light=new C.DirectionalLight({direction:new C.Cartesian3(-1,-.6,-.8),intensity:2.5});
      scene.primitives.add(model);attached=true;model.show=true;
      this.heading=.7;this.pitch=-.4;this.range=Math.max(10,(asset.size_m || 30)*2);this.center=origin;
      const pose=this.pose=()=>{scene.camera.lookAt(this.center,new C.HeadingPitchRange(this.heading,this.pitch,this.range));scene.requestRender?.();};
      pose();
      const fail=this.fail=()=>{if(generation===this.generation){this.close();this.onStatus('error');}};
      const ready=()=>{
        if(generation!==this.generation)return;
        this.ready=true;clearTimeout(this.readyTimer);widget.resize();
        const bounds=model.boundingSphere;this.center=C.Cartesian3.clone(bounds.center);
        const aspect=Math.max(.2,this.container.clientWidth/Math.max(1,this.container.clientHeight));
        const fov=Math.min(scene.camera.frustum.fovy,2*Math.atan(Math.tan(scene.camera.frustum.fovy/2)*aspect));
        this.minimumRange=Math.max(1,bounds.radius*1.15);this.range=Math.max(2,bounds.radius/Math.sin(fov/2)*1.08);
        this.baseRange=this.range;pose();this.onStatus('ready');
      };
      model.readyEvent.addEventListener(ready);if(model.ready)ready();
      model.errorEvent.addEventListener(fail);scene.renderError.addEventListener(fail);
      const canvas=widget.canvas;let drag=null;
      canvas.tabIndex=0;canvas.setAttribute('aria-label','3D 대표 모델. 방향키로 회전, 더하기와 빼기로 확대 축소');
      const key=event=>this.handleKey(event);canvas.addEventListener('keydown',key);
      const down=event=>{if(event.button!==0)return;drag={x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);};
      const move=event=>{if(!drag)return;this.heading-=(event.clientX-drag.x)*.009;this.pitch=Math.max(-1.4,Math.min(1.4,this.pitch+(event.clientY-drag.y)*.009));drag={x:event.clientX,y:event.clientY};pose();};
      const up=()=>{drag=null;};
      const wheel=event=>{event.preventDefault();this.range=Math.max(this.minimumRange || 1,Math.min((this.baseRange || 100)*5,this.range*Math.exp(event.deltaY*.001)));pose();};
      canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('wheel',wheel,{passive:false});
      // No decorative auto-spin: a second continuously drawn WebGL canvas
      // competes with the actual map even when nobody is inspecting the model.
      const visibility=()=>this.setVisible(!document.hidden);
      document.addEventListener('visibilitychange',visibility);visibility();
      const resize=new ResizeObserver(()=>{widget.resize();scene.requestRender?.();});resize.observe(this.container);
      this.cleanup=()=>{resize.disconnect();document.removeEventListener('visibilitychange',visibility);
        canvas.removeEventListener('keydown',key);canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('wheel',wheel);};
    } catch {
      if(model && !attached && !model.isDestroyed?.())model.destroy();
      if(generation===this.generation){this.close();this.onStatus('error');}
    }
  }
  setVisible(visible) {
    if(!this.widget)return;
    this.widget.useDefaultRenderLoop=visible;clearTimeout(this.readyTimer);
    if(visible)this.widget.scene?.requestRender?.();
    if(visible && !this.ready)this.readyTimer=setTimeout(()=>this.fail?.(),20000);
  }
  handleKey(event) {
    switch(event.key) {
      case 'ArrowLeft':this.heading-=.12;break;
      case 'ArrowRight':this.heading+=.12;break;
      case 'ArrowUp':this.pitch=Math.max(-1.4,this.pitch-.1);break;
      case 'ArrowDown':this.pitch=Math.min(1.4,this.pitch+.1);break;
      case '+':case '=':this.range=Math.max(this.minimumRange || 1,this.range*.85);break;
      case '-':this.range=Math.min((this.baseRange || 100)*5,this.range/ .85);break;
      default:return;
    }
    event.preventDefault();this.pose?.();
  }
  close() {
    this.generation++;this.assetId=null;this.ready=false;this.fail=null;this.pose=null;clearTimeout(this.readyTimer);this.cleanup?.();this.cleanup=null;
    // The preview is closed and reopened on every selection; released, not
    // merely destroyed, or the map's context is the one that goes.
    releaseWidgetContext(this.widget);this.widget=null;
  }
}
