// A bounded upload unit, not a new renderer. Cesium still owns worker geometry,
// GL buffers and draw commands. Only one unfinished child may advance per frame
// across a layer; resident children always render at the normal frame cadence.
export class StagedPrimitive {
  constructor(parts,gate={}) {
    this.parts=parts;this.gate=gate;this.show=true;this.cursor=0;this.disposed=false;
  }
  get ready(){return this.cursor>=this.parts.length;}
  update(frameState){
    if(this.disposed)return;
    // Pick/preload passes must not spend the render frame's loading allowance.
    const render=frameState.passes?.render!==false;
    for(let i=0;i<this.cursor;i++){
      const part=this.parts[i];part.show=this.show;part.update(frameState);
    }
    if(this.ready||!render)return;
    const frame=frameState.frameNumber;
    if(frame!==undefined&&this.gate.frame===frame)return;
    this.gate.frame=frame;
    const part=this.parts[this.cursor];
    // Hidden cells must finish preparation so the old cell can be exchanged.
    part.show=this.show;part.update(frameState);
    if(part.ready===true)this.cursor++;
  }
  isDestroyed(){return this.disposed;}
  destroy(){
    if(this.disposed)return;
    this.disposed=true;
    for(const part of this.parts)if(!part.isDestroyed?.())part.destroy?.();
    this.parts=[];
  }
}
