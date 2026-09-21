const $=id=>document.getElementById(id);
const fields=['host','web_port','ssh_port','username','forward_port','identity_file','auto_connect'];
const labels={disconnected:'연결 해제',connecting:'연결 중',connected:'터널 연결',error:'연결 확인 필요'};
export function mountConnection(){
  let initialized=false,busy=false;
  const feedback=(message,error=false)=>{$('link-feedback').textContent=message;$('link-feedback').classList.toggle('error',error);};
  async function request(action,value){
    const response=await fetch('/api/v1/console/connection'+(action?'/'+action:''),{cache:'no-store',signal:AbortSignal.timeout(35000),...(action?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value||{})}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.message||'연결 요청 실패');return result;
  }
  function populate(settings){for(const id of fields){const input=$('link-'+id);if(id==='auto_connect')input.checked=settings[id];else input.value=settings[id]??'';}$('link-dirty').textContent='저장된 설정';$('link-dirty').classList.remove('dirty');}
  function paint(value){
    if(!initialized){populate(value.settings);initialized=true;feedback('주소와 인증 정보를 확인하고 적용 · 연결을 누르세요.');}
    const d=value.diagnostics||{};
    $('twin-link').hidden=!value.twin_url;if(value.twin_url)$('twin-link').href=value.twin_url;
    $('link-badge').textContent=d.receiving?'Twin 수신 중':labels[value.status]||value.status;$('link-badge').dataset.ready=String(!!d.receiving);
    $('link-local').textContent=value.physical_url;$('sensor-api-url').textContent=value.physical_url;
    $('link-destination').textContent=value.twin_url||'대상 PC를 입력해 주세요.';$('link-receiver').textContent=value.receiver_url;
    $('diag-tunnel').textContent=value.tunnel_running?'연결됨':'연결되지 않음';$('diag-api').textContent=d.twin_api?'응답 확인':'응답 대기';
    $('diag-receiving').textContent=d.receiving?'현재 센서 수신 확인':d.this_publisher?'이 PC의 관측 존재 · 최신 갱신 대기':'이 PC의 관측 수신 대기';
    $('diag-aircraft').textContent=d.received_aircraft?`${d.received_aircraft}기체 · 최신 관측 ${d.fresh_aircraft}기체`:d.aircraft?`${d.aircraft} · #${d.sequence}`:'—';
    $('diag-age').textContent=Number.isFinite(d.measurement_age_s)?`${d.measurement_age_s.toFixed(2)} s`:'—';$('diag-rtt').textContent=Number.isFinite(d.rtt_ms)?`${d.rtt_ms} ms`:'—';
    $('link-checked').textContent=d.checked_at?new Date(d.checked_at*1000).toLocaleTimeString()+' 확인':'—';
    $('link-message').textContent=value.message;$('sensor-link-status').textContent=value.message;
  }
  async function refresh(){try{paint(await request());}catch(e){$('link-message').textContent='Physical 콘솔 서버 응답을 기다립니다.';}finally{setTimeout(refresh,3000);}}
  for(const name of fields)$('link-'+name).oninput=()=>{$('link-dirty').textContent='미적용 변경';$('link-dirty').classList.add('dirty');};
  for(const action of ['connect','check','disconnect'])$('link-'+action).onclick=async()=>{
    if(busy)return;busy=true;for(const a of ['connect','check','disconnect'])$('link-'+a).disabled=true;
    feedback(action==='connect'?'SSH와 Twin API를 연결하고 수신 주소를 적용합니다.':'연결 상태를 확인하고 있습니다.');
    try{
      const config=Object.fromEntries(fields.map(id=>[id,id==='auto_connect'?$('link-'+id).checked:id.endsWith('port')?Number($('link-'+id).value):$('link-'+id).value.trim()]));
      const value=await request(action,action==='connect'?config:{});paint(value);
      if(action!=='check')populate(value.settings);
      feedback(action==='connect'?'연결 설정을 저장·적용했습니다. 오른쪽에서 실제 수신 상태를 확인하세요.':value.message);
    }catch(e){feedback(e.message,true);}
    finally{busy=false;for(const a of ['connect','check','disconnect'])$('link-'+a).disabled=false;}
  };
  refresh();
}
