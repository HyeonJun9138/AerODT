// Initial camera only, using public Cesium events. No tile prefetch or physics.
// Provider attachment is not tile readiness. tilesLoaded can also be true after
// failed requests, so provider errors must be checked independently.
export function waitForInitialView({scene,read,onStatus=()=>{},signal,
  timeoutMs=30000,stableMs=500,now=()=>performance.now(),
  isVisible=()=>typeof document==='undefined' || !document.hidden,
  onVisibilityChange=fn=>{
    if(typeof document==='undefined')return ()=>{};
    document.addEventListener('visibilitychange',fn);
    return ()=>document.removeEventListener('visibilitychange',fn);
  },
  setTimer=setTimeout,clearTimer=clearTimeout}) {
  return new Promise((resolve,reject)=>{
    let removeFrame,removeError,removeCamera,removeVisibility,timer=null,settled=false,start=null,frames=0,lastMessage='';
    let remaining=timeoutMs,deadlineStarted=now();
    const finish=error=>{
      if(settled)return;settled=true;
      removeFrame?.();removeError?.();removeCamera?.();removeVisibility?.();clearTimer(timer);signal?.removeEventListener('abort',cancel);
      error?reject(error instanceof Error?error:new Error(error)):resolve();
    };
    const cancel=()=>finish('초기 지도 준비가 취소되었습니다.');
    if(signal?.aborted){cancel();return;}
    signal?.addEventListener('abort',cancel,{once:true});
    removeError=scene.renderError.addEventListener(()=>finish('지구 렌더링에 실패했습니다. WebGL 상태를 확인하고 다시 시도해 주세요.'));
    const reset=()=>{start=null;frames=0;};
    removeCamera=scene.camera?.changed?.addEventListener(reset);
    removeFrame=scene.postRender.addEventListener(()=>{
      if(settled || !isVisible())return;
      try{
        const state=read();
        if(state.imagery==='error'){finish('지도 영상 수신에 실패했습니다. 네트워크를 확인하고 다시 시도해 주세요.');return;}
        if(state.terrain==='error' || state.terrain==='unavailable'){
          finish(state.terrain==='unavailable'?'지형 인증 설정이 필요합니다. 설정 후 다시 시도해 주세요.':'지형 데이터 수신에 실패했습니다. 연결을 확인하고 다시 시도해 주세요.');return;
        }
        const ready=state.imagery==='ready' && state.terrain==='ready' && state.tilesLoaded;
        const message=state.imagery!=='ready'?'지도 영상 수신 중':state.terrain!=='ready'?'지형 데이터 준비 중':!state.tilesLoaded?'현재 시야의 지도·지형 타일 수신 중':'지도 화면 안정화 확인 중';
        if(message!==lastMessage){lastMessage=message;onStatus(message,state);}
        if(settled)return;
        if(!ready)reset();
        else {
          if(start===null)start=now();
          if(++frames>=3 && now()-start>=stableMs){finish();return;}
        }
        // Cached tiles may not request another frame. Keep drawing until the
        // stable window has been observed, even with requestRenderMode enabled.
        scene.requestRender();
      }catch(error){finish(error);}
    });
    const schedule=()=>{
      deadlineStarted=now();
      timer=setTimer(()=>finish('초기 지도 준비 시간이 초과되었습니다. 지도 또는 지형 수신 상태를 확인하고 다시 시도해 주세요.'),Math.max(0,remaining));
    };
    removeVisibility=onVisibilityChange(()=>{
      if(settled)return;
      reset();
      if(timer!==null){remaining-=Math.max(0,now()-deadlineStarted);clearTimer(timer);timer=null;}
      if(isVisible()){schedule();scene.requestRender();}
    });
    if(isVisible())schedule();
    scene.requestRender();
  });
}
