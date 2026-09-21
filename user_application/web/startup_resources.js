// Start independent network work together. Each optional response settles on
// its own; a missing catalogue must not discard a valid live snapshot.
export function startStartupResources({loadEngine,loadJSON,signal}) {
  const engine=Promise.resolve().then(()=>loadEngine({signal}));
  // The shell is still being assembled when the network may fail. Keep the
  // rejection observed now and let the boot await report the original error.
  engine.catch(()=>{});
  const data=Promise.allSettled([
    Promise.resolve().then(()=>loadJSON('/api/visual-assets',{signal})),
    Promise.resolve().then(()=>loadJSON('/api/live/snapshot',{signal})),
  ]);
  return {engine,data};
}

// One owner for script callbacks, timeout and abort. Late load/error callbacks
// from an abandoned navigation cannot restart an already failed boot.
export function loadStartupEngine({document,scope=globalThis,signal,
  baseUrl='https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/',
  timeoutMs=30000,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  if(signal?.aborted)return Promise.reject(new Error('화면 준비가 취소되었습니다.'));
  scope.CESIUM_BASE_URL=baseUrl;
  if(scope.Cesium)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    let settled=false,timer=null;
    const finish=error=>{
      if(settled)return;
      settled=true;clearTimer(timer);signal?.removeEventListener('abort',abort);
      script.onload=null;script.onerror=null;
      if(error){script.remove();reject(error);}else resolve();
    };
    const abort=()=>finish(new Error('화면 준비가 취소되었습니다.'));
    script.src=baseUrl+'Cesium.js';script.async=true;
    script.onload=()=>finish(scope.Cesium?null:new Error('Cesium 초기화 실패'));
    script.onerror=()=>finish(new Error('시각화 엔진을 불러오지 못했습니다. 네트워크를 확인해 주세요.'));
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimer(()=>finish(new Error('시각화 엔진 연결 시간이 초과되었습니다. 네트워크를 확인해 주세요.')),timeoutMs);
    try{document.head.append(script);}catch(error){finish(error);}
  });
}

// The HTML can preload these bytes without blocking the loading surface's
// first paint. The boot still waits for the stylesheet before creating Cesium,
// so its canvas is never sized against an unstyled viewer container.
export function loadStartupStylesheet({document,signal,
  url='https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/Widgets/widgets.css',
  timeoutMs=30000,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  if(signal?.aborted)return Promise.reject(new Error('화면 준비가 취소되었습니다.'));
  return new Promise((resolve,reject)=>{
    const link=document.createElement('link');
    let settled=false,timer=null;
    const finish=error=>{
      if(settled)return;
      settled=true;clearTimer(timer);signal?.removeEventListener('abort',abort);
      link.onload=null;link.onerror=null;
      if(error){link.remove();reject(error);}else resolve();
    };
    const abort=()=>finish(new Error('화면 준비가 취소되었습니다.'));
    link.rel='stylesheet';link.href=url;
    link.onload=()=>finish();
    link.onerror=()=>finish(new Error('지도 화면 스타일을 불러오지 못했습니다. 네트워크를 확인해 주세요.'));
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimer(()=>finish(new Error('지도 화면 스타일 연결 시간이 초과되었습니다. 네트워크를 확인해 주세요.')),timeoutMs);
    try{document.head.append(link);}catch(error){finish(error);}
  });
}
