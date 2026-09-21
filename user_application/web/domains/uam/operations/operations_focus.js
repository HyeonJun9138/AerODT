// UI navigation only: no simulation commands or replay clock changes.
export class OperationsFocus {
  constructor({globe,readDeck,notice=()=>{}}){Object.assign(this,{globe,readDeck,notice});this.revision=0;}
  aircraft(id){
    ++this.revision;
    const globe=this.globe(),key=String(id).includes(':')?id:
      (globe?.items?.has(`physical:${id}`)?`physical:${id}`:`scenario:${id}`);
    if(!id||!globe?.items?.has(key)){this.notice('현재 기체 위치를 확인할 수 없습니다.');return;}
    globe.select(key);
    globe.focus(true); // Explicit focus, not the map's click-to-toggle action.
  }
  async deck(id){
    const revision=++this.revision;
    try{
      const record=await this.readDeck(id);
      if(revision!==this.revision)return;
      const frame=record?.layout?.frame??record;
      if(!Number.isFinite(frame?.latitude)||!Number.isFinite(frame?.longitude))throw new Error('no position');
      this.globe()?.flyToVertiport(frame);
    }catch{
      if(revision===this.revision)this.notice('버티포트 위치를 불러오지 못했습니다.');
    }
  }
}
