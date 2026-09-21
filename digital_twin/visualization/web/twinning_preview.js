import {ModelPreview} from './model_preview.js';
import {loadVisualModel} from './visual_asset_loader.js';

// Incoming quaternion is already expressed in X-forward, Y-left, Z-up axes.
export class TwinningPreview extends ModelPreview {
  constructor(C,container,onStatus,options={}){
    let instance;
    super(C,container,onStatus,{...options,loadModel:async(C,asset,id,matrix)=>{
      const generation=instance.generation;
      const model=await loadVisualModel(C,asset,id,matrix);
      if(generation===instance.generation){instance.model=model;instance.base=C.Matrix4.clone(matrix);}
      return model;
    }});instance=this;
  }
  setAttitude([w,x,y,z],mountDeg=0){
    if(!this.model||!this.ready||!this.base)return;
    const C=this.C;
    this.pivot??=C.Matrix4.multiplyByPoint(C.Matrix4.inverse(this.base,new C.Matrix4()),this.center,new C.Cartesian3());
    const rotation=C.Matrix3.fromQuaternion(new C.Quaternion(x,y,z,w));
    const mounting=C.Matrix3.fromRotationZ(mountDeg*Math.PI/180);
    C.Matrix3.multiply(rotation,mounting,rotation);
    const plus=C.Matrix4.fromTranslation(this.pivot),minus=C.Matrix4.fromTranslation(C.Cartesian3.negate(this.pivot,new C.Cartesian3()));
    const local=C.Matrix4.multiply(plus,C.Matrix4.fromRotationTranslation(rotation),new C.Matrix4());
    C.Matrix4.multiply(local,minus,local);
    this.model.modelMatrix=C.Matrix4.multiply(this.base,local,new C.Matrix4());
    this.widget.scene.requestRender();
  }
  close(){super.close();this.model=null;this.base=null;this.pivot=null;}
}
