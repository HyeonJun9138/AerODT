import {buildElement} from '../../../dom_builder.js';

// Another view of confirmed Live Twin settings, never a second settings store.
export class UamPredictionControls {
  constructor({document=globalThis.document,onChange=async()=>false,onSettings=()=>{}}={}) {
    this.onChange=onChange;this.values=null;this.busy=false;
    const el=(tag,props,...children)=>buildElement(document,tag,props,...children);
    this.root=el('section',{class:'uam-prediction-controls','aria-label':'UAM 예측 시각화'});
    this.master=el('button',{type:'button',class:'uam-display-row',role:'switch','aria-label':'UAM 예측정보 표시',
      onclick:()=>this.change('enabled',!this.values?.enabled)},el('span',{text:'예측정보 표시'}),el('i',{'aria-hidden':'true'}));
    this.horizons=el('div',{class:'uam-prediction-horizons'});this.buttons=new Map();
    for(const [key,label] of [['short_enabled','10초'],['mid_enabled','90초'],['long_enabled','240초']]){
      const button=el('button',{type:'button',text:label,'aria-label':`예측 ${label} 표시`,'data-horizon':key,
        onclick:()=>this.change(key,this.values?.[key]===false)});
      this.buttons.set(key,button);this.horizons.append(button);
    }
    this.note=el('p',{'aria-live':'polite'});
    this.settings=el('button',{type:'button',class:'uam-prediction-settings',text:'예측 모델 설정',onclick:onSettings});
    this.root.append(this.master,this.horizons,this.note,this.settings);this.render();
  }
  update(values){this.values=values?{...values}:null;this.render();}
  async change(key,value){
    const button=key==='enabled'?this.master:this.buttons.get(key);
    if(!button||button.disabled||this.busy||!this.values)return;
    this.busy=true;this.failed=false;this.render();
    try{this.failed=(await this.onChange(key,value))===false;}catch{this.failed=true;}
    finally{this.busy=false;this.render();}
  }
  render(){
    const v=this.values,comparison=v?.model==='uam_route_mlp_comparison';
    this.root.setAttribute('aria-busy',String(this.busy));
    this.master.disabled=!v||this.busy;this.master.setAttribute('aria-checked',String(Boolean(v?.enabled)));
    for(const [key,button] of this.buttons){button.disabled=!v||!v.enabled||!comparison||this.busy;button.setAttribute('aria-pressed',String(v?.[key]!==false));}
    this.settings.disabled=this.busy;
    this.note.textContent=this.failed?'저장하지 못했습니다. 다시 시도해 주세요.':this.busy?'예측 표시 설정 적용 중…':!v?'예측 설정 불러오는 중…':
      comparison?'선택 UAM · Live Twin과 동기화 · 경로 표시만 선택':'개별 예측 모델 사용 중 · 구간 변경은 예측 모델 설정에서';
  }
}
