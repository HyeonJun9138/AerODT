import {LABEL_FADE_MS,labelFadeAlpha,labelDistanceAlpha} from './label_fade.js';

const valueOf=(property,time)=>property?.getValue ? property.getValue(time) : property;
// Presentation only: keep label colours, picking and operator visibility intact.
// Weak keys release annotations when their route or vertiport is rebuilt.
export class InfrastructureLabelFade {
  // `started` counts the fades that began, so a caller can tell an idle pass
  // from one that has a fade to finish.
  constructor(C) {this.C=C;this.states=new WeakMap();this.started=0;}
  // Fade everything in again from nothing. Nothing else is remembered here:
  // opacity is written as translucencyByDistance and the label's own colours
  // are never touched, so there is no full-strength value to lose.
  restart() {this.states=new WeakMap();}
  update(entities,viewer,now,enabled=true,scaleFloor=0,fadeMs=LABEL_FADE_MS,includePoints=false) {
    const C=this.C,time=viewer.clock?.currentTime,scene=viewer.scene;
    for(const entity of entities){
      for(let index=0;index<(includePoints?2:1);index++){
        const label=index===0?entity.label:entity.point;
        if(!label)continue;
        const position=valueOf(entity.position,time),range=valueOf(label.distanceDisplayCondition,time);
        let shown=enabled && entity.show!==false && entity.isShowing!==false && valueOf(label.show,time)!==false;
        let distanceAlpha=1;
        if(shown && position && range){
          const distance=scene.mode===C.SceneMode?.SCENE2D
            ? viewer.camera.positionCartographic.height
            : C.Cartesian3.distance(viewer.camera.positionWC,position);
          shown=distance>=range.near && distance<=range.far;
          distanceAlpha=labelDistanceAlpha(distance,range.near,range.far);
        }
        let state=this.states.get(label);
        if(!state){state={shown:false,alpha:null};this.states.set(label,state);}
        // The length is fixed when the fade begins, so a label that started
        // appearing on the slow arrival curve is not jerked onto a faster one
        // half way up.
        if(shown && !state.shown){state.start=now;state.duration=fadeMs;this.started++;}
        state.shown=shown;
        const scale=valueOf(label.scale,time)??1;
        const scaleAlpha=scaleFloor>0?labelFadeAlpha((scale-scaleFloor)/.15*LABEL_FADE_MS):1;
        const alpha=shown ? labelFadeAlpha(now-state.start,state.duration)*distanceAlpha*scaleAlpha : 0;
        if(alpha!==state.alpha){
          // Multiplicative opacity preserves hover/selection colours and outlines.
          label.translucencyByDistance=new C.NearFarScalar(0,alpha,1e12,alpha);
          state.alpha=alpha;
        }
      }
    }
  }
}
