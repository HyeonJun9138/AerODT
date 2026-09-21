import {geoToEcef,checkedForecast} from './prediction_data.js';
// Deliberately separate demonstration, never merged into a live snapshot.
export function predictionExample(){
  const now=1000,epoch=0;
  const ports=[{id:'EX-V1',name:'여의도',latitude:37.5249,longitude:126.9203},{id:'EX-V2',name:'잠실',latitude:37.515,longitude:127.076},
    {id:'EX-V3',name:'상암',latitude:37.579,longitude:126.89},{id:'EX-V4',name:'용산',latitude:37.532,longitude:126.966},
    {id:'EX-V5',name:'천호',latitude:37.542,longitude:127.12}];
  const definitions=[['01',37.532,126.958,37.529,126.99,310,90],['02',37.518,126.975,37.544,126.975,345,0],
    ['03',37.531,126.881,37.526,126.926,260,90],['04',37.56,126.9,37.54,126.942,320,135],
    ['05',37.52,127.044,37.527,127.083,300,80],['06',37.542,127.09,37.542,127.12,260,90]];
  const entities=[],forecasts=new Map();
  for(const [id,lat,lon,toLat,toLon,height,heading] of definitions){
    const entity={entity_id:`example:${id}`,name:`UAM ${id}`,kind:'uam',latitude_deg:lat,longitude_deg:lon,altitude_m:height,
      heading_deg:heading,flight_phase:'cruise',continuity_id:1,state_time:now,quality:'valid',source:'example',provenance:'fixture'};
    entities.push(entity);
    const predictions=[['uam_route_mlp_short',10],['uam_route_mlp_mid',90],['uam_route_mlp_long',240]].map(([model,seconds])=>({model_id:model,status:'ready',horizon_seconds:seconds,
      path:{schema_version:1,kind:'aircraft',entity_id:entity.entity_id,epoch,continuity_id:1,flight_phase:'cruise',reference_frame:'ecef_m',
        summary:{model},note:'개념 시연용 합성 경로 · 실제 AI 추론 아님',points:Array.from({length:25},(_,i)=>{const time=i*seconds/24,u=time/90;
          return [now+time,...geoToEcef(lat+(toLat-lat)*u,lon+(toLon-lon)*u,height+(id==='03'?-20:8)*u)];})}}));
    forecasts.set(entity.entity_id,checkedForecast({schema_version:2,kind:'uam_prediction_comparison',entity_id:entity.entity_id,epoch,continuity_id:1,flight_phase:'cruise',generated_at:now,predictions},entity,epoch));
  }
  const nodes=[...ports,{id:'EX-W1',name:'중앙 회랑',latitude:37.53,longitude:126.978},{id:'EX-W2',name:'한강 동측',latitude:37.53,longitude:127.042}];
  const links=[['EX-V3','EX-V1'],['EX-V1','EX-V4'],['EX-V4','EX-W1'],['EX-W1','EX-W2'],['EX-W2','EX-V2'],['EX-V2','EX-V5'],['EX-W1','EX-V5']].map(([from,to],i)=>({id:`EX-L${i}`,from,to,segment:'F'}));
  return {snapshot:{schema_version:1,state_time:now,epoch,entities},ports,network:{nodes,fatos:[],links},forecasts};
}
