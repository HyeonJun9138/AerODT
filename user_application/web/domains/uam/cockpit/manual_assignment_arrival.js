// Assignment is asynchronous with the fleet snapshot and scene/model loading.
// Getting in is a loading screen and then the seat, with no journey in between.
//
// It used to be a tour. The camera glided to the aircraft over 1.4-3.4 s, then
// flew an approach animation, and only once that had landed did the airframe
// begin loading -- so the operator watched their own map go past and then waited
// again for the model, every time. Nothing about a cockpit needs the camera to
// have travelled: `CockpitView.enter` reads the selection and takes the camera
// over outright. So the model is asked for the moment the object exists, the
// approach is landed in a single frame once the seat is ready, and the screen in
// front of all of it is what the operator actually sees.
//
// The approach is still set up and landed rather than skipped: its end state is
// the camera anchored on the aircraft and tracking it, which is the view handed
// back on leaving the cockpit and the basis of the external follow.
export async function arriveAtManualAircraft({aircraftId,getGlobe,isCurrent=()=>true,
 now=()=>performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=25000,onProgress=()=>{}}){
 const id=`scenario:${aircraftId}`,deadline=now()+timeoutMs;
 const current=()=>{if(!isCurrent())throw new Error('수동 기체 진입 취소');};
 let selected=false,modeRequested=false;
 onProgress('배정 기체 수신 대기');
 while(now()<deadline){
  current();const g=getGlobe();
  if(!g||g.entryActive||g.transitioning){await wait(100);continue;}
  if(g.sceneMode==='2d'){
   if(!modeRequested){modeRequested=true;onProgress('3D 시점 준비 중');await g.setSceneMode('3d');current();}
   await wait(100);continue;
  }
  const item=g.items.get(id);
  if(!item){await wait(100);continue;}
  if(!selected){
   // Selecting is what the cockpit reads, and it is also what keeps the model
   // from being retired while it loads. On its own it moves no camera.
   g.select(id);selected=true;onProgress('기체 모델 준비 중');
  }else if(g.selected!==id){throw new Error('대상 변경으로 수동 기체 진입을 취소했습니다.');}
  g.prepareModel?.(id);
  if(g.cockpit?.usable(item)){
   current();
   // Set the framing and land it in the same breath, under the screen.
   g.focus(true);g.finishApproach?.();
   if(!g.cockpit.enter())throw new Error('배정 기체 조종석 진입 실패');
   onProgress('조종석 준비 완료');return id;
  }
  await wait(100);
 }
 current();throw new Error(selected?'배정 기체의 모델 준비 시간이 초과되었습니다.':'배정 기체를 지도에서 받지 못했습니다. 다중 운항 연결 상태를 확인하세요.');
}
