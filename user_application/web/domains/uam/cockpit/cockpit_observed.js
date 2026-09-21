// Read-only presentation. Attitude/RPM do not reconstruct a pilot's command.
const finite=Number.isFinite;
const bounded=(x,max=1)=>Math.max(-max,Math.min(max,finite(x)?x:0));
const id=x=>String(x??'').replace(/^(scenario|physical):/,'');
export function observedCockpit(entity={},sample={},detail=null){
 const state=id(detail?.state?.aircraft_id)===id(entity.entity_id)&&entity.entity_id?detail.state:{};
 const value=k=>finite(sample[k])?sample[k]:finite(entity[k])?entity[k]:null;
 const rotor=value('rotor_radps'),flow=state.passenger_flow,energy=state.energy??{};
 const flight=entity.flight_phase??state.phase;
 const airborne=['gate_out','gate_in','parked','charge'].includes(flight)?false:state.airborne===true||['takeoff','climb','cruise','holding','hold','hold_exit','hold_return','descent','approach','landing'].includes(flight);
 const charge=entity.charge_state??energy.charge_state;
 const phase=airborne?'airborne':flow?.phase==='boarding'?'boarding':flow?.phase==='alighting'?'alighting':
  ['connecting','charging','complete'].includes(charge)?charge:['gate_in','gate_out'].includes(flight)?'taxi':flight==='parked'?'parked':'unknown';
 const passengers=finite(flow?.on_board)?flow.on_board:finite(state.on_board)?state.on_board:null;
 return {
  // Fixed display ranges only: 30 degrees of bank/pitch and 600 rad/s.
  // They are not calibrated control travel, engine limits or control commands.
  controls:{enabled:false,source:'observation',throttle:Math.max(0,bounded(rotor/600)),roll:bounded(value('roll_deg')/30),pitch:bounded(value('pitch_deg')/30),yaw:0},
  telemetry:{battery_pct:finite(entity.battery_pct)?entity.battery_pct:state.battery_pct,passengers},
  ground:{phase,readOnly:true,available:false,passengers_remaining:passengers,
   door_state:state.door_state??'미수신',charger_state:airborne?'NOT IN USE':({connecting:'CONNECTING',charging:'CONNECTED',complete:'COMPLETE',idle:'STANDBY',disconnected:'DISCONNECTED'})[charge]??'미수신',
   reason:'자동 운항 · 조작부는 자세/로터 연동 표시 · 실제 조종 입력 아님'},
 };
}
