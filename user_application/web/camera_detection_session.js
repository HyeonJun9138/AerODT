// One bounded request, paired with its exact captured frame. No simulation truth
// enters this client; results from previous targets or switches are discarded.
export class CameraDetectionSession {
 constructor({request,release=()=>{},onResult=()=>{},onStatus=()=>{},now=()=>Date.now(),makeId=()=>crypto.randomUUID()}={}){
  Object.assign(this,{request,release,onResult,onStatus,now,makeId});this.enabled=false;this.generation=0;this.sequence=0;this.last=-Infinity;this.pending=null;
 }
 invalidate(){
  this.generation++;this.abort?.abort();
  if(this.sent&&this.sessionId)Promise.resolve(this.release(this.sessionId)).catch(()=>{});
  this.sent=false;this.sessionId=this.makeId();this.sequence=0;this.last=-Infinity;
 }
 select(entityId,camera){if(entityId===this.entityId&&camera===this.camera)return;this.invalidate();Object.assign(this,{entityId,camera});}
 setEnabled(enabled){if(this.enabled===enabled)return;this.enabled=enabled;this.invalidate();this.onStatus(enabled?'모델 준비 중':'AI OFF');}
 suspend(){this.invalidate();}
 checkAge(){if(this.enabled&&this.pending&&this.now()-this.last>1000)this.onStatus('AI 준비 / 응답 지연');}
 async submit(frame){
  if(!this.enabled||!this.entityId||this.pending||this.now()-this.last<200)return;
  const generation=this.generation,body={session_id:this.sessionId,entity_id:this.entityId,camera:this.camera,frame_id:++this.sequence,captured_at:this.now(),width:frame.width,height:frame.height,image_base64:frame.image_base64};
  this.last=body.captured_at;this.sent=true;const abort=new AbortController();this.abort=abort;
  const pending={};this.pending=pending;
  try{
   const result=await this.request(body,abort.signal);
   if(generation!==this.generation||!this.enabled)return;
   if(['session_id','entity_id','camera','frame_id','captured_at','width','height'].some(k=>result[k]!==body[k])){this.onStatus('영상 시점 불일치');return;}
   if(this.now()-body.captured_at>1000){this.onStatus('AI 지연 / 최신 영상 유지');return;}
   if(!Array.isArray(result.detections))throw new Error('invalid detections');
   this.onResult(result,frame);this.onStatus(`AI ON / ${Math.round(result.inference_ms??0)} ms`);
  }catch(error){if(generation===this.generation&&this.enabled)this.onStatus(error.name==='AbortError'?'AI 응답 지연':error.message||'모델 연결 실패');}
  finally{if(this.pending===pending){this.pending=null;this.abort=null;}}
 }
 destroy(){this.enabled=false;this.invalidate();}
}
