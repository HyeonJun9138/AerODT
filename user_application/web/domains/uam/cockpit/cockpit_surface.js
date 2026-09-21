import {describePilotDecision} from '../operations/pilot_decision.js';
// Read-only destination/PSU chart. A plan is never represented as a clearance.
const finite=Number.isFinite;
const sameId=(a,b)=>Boolean(a&&b&&String(a).split(':').pop()===String(b).split(':').pop());
export const surfaceDistance=(a,b)=>!a||!b?Infinity:Math.hypot((a.latitude_deg-b.latitude_deg)*111320,(((a.longitude_deg-b.longitude_deg+540)%360)-180)*111320*Math.cos(b.latitude_deg*Math.PI/180));
export function surfaceChart(records,position,plan,detail,psu){
 if(psu?.procedure){
  const p=psu.procedure,arriving=psu.airborne||p.reports?.report_landed!=null;
  const id=arriving?p.destination:p.origin,gate=arriving?p.arrival_gate:p.departure_gate,fato=arriving?p.arrival_fato:p.departure_fato;
  const endpoint={vertiport:id,gate,fato};
  const chart=surfaceChart(records,{...position,stage:arriving?'gate_in':'gate_out',phase:arriving?'gate_in':'gate_out',manual:false},
   {departure:endpoint,arrival:endpoint},null);
  if(!chart)return null;
  const stale=Boolean(psu.stale||psu.error),ground=p.ground_chart?.vertiport===id?p.ground_chart:null;
  return {...chart,assigned:true,stale,liveGate:gate,liveFato:fato,instruction:p.reason||p.text,
   taxiGranted:!stale&&Boolean(ground?.taxi_granted),
   taxiPath:stale?[]:ground?.points??[],occupied:stale?[]:ground?.occupied??[]};
 }
 if(!finite(position?.latitude_deg)||!finite(position?.longitude_deg))return null;
 const state=sameId(position.entity_id,detail?.state?.aircraft_id)?detail.state:null;
 const flight=state?detail.flight:null,c=state?.clearance;
 const phase=position.phase??position.flight_phase??position.stage??state?.phase;
 const departing=['gate_out','takeoff','boarding'].includes(phase);
 let end=departing?plan?.departure:plan?.arrival??plan?.departure;
 // Manual contact does not distinguish arrival from departure. On the ground,
 // identify which planned deck we actually reached, including taxi from its FATO.
 if(position.manual&&position.airborne===false){
  const proximity=endpoint=>{const f=records?.get(endpoint?.vertiport)?.layout?.frame;return f?surfaceDistance(position,{latitude_deg:f.latitude,longitude_deg:f.longitude}):Infinity;};
  const arrivalDistance=proximity(plan?.arrival),departureDistance=proximity(plan?.departure);
  if(arrivalDistance<250&&arrivalDistance<=departureDistance)end=plan.arrival;
  else if(departureDistance<250)end=plan.departure;
 }
 const plannedId=end?.vertiport??(departing?flight?.origin:flight?.destination)??state?.destination;
 const requested=c?.vertiport??plannedId??state?.vertiport;
 let chosen=requested&&records?.get(requested)?{id:requested,record:records.get(requested)}:null;
 if(!chosen){let nearest=2000;for(const [id,record] of records??[]){const f=record.layout?.frame;if(!f)continue;
  const distance=surfaceDistance(position,{latitude_deg:f.latitude,longitude_deg:f.longitude});
  if(distance<nearest){nearest=distance;chosen={id,record};}
 }}
 // Keep an assignment visible even if its geometry has not arrived yet.
 if(!chosen&&!requested)return null;
 const {id,record={}}=chosen??{id:requested},layout=record.layout??{},frame=layout.frame;
 const center=frame?{latitude_deg:frame.latitude,longitude_deg:frame.longitude}:null;
 const point=([east,north])=>({longitude_deg:frame.longitude+east/(111320*Math.cos(frame.latitude*Math.PI/180)),latitude_deg:frame.latitude+north/111320});
 const planned=end?.vertiport===id?end:null;
 const assigned=c?.vertiport===id?c:null;
 const plannedGate=planned?.gate??(id===flight?.destination?flight.arrival_stand:null);
 const plannedFato=planned?.fato??(id===flight?.destination?flight.arrival_fato:null);
 const liveGate=assigned?.stand??(state?.vertiport===id?state.stand:null);
 return {id,name:record.name??planned?.name??id,center,distance_m:surfaceDistance(position,center),
  gate:liveGate??plannedGate??null,fato:assigned?.fato??plannedFato??null,
  liveGate:liveGate??null,liveFato:assigned?.fato??null,plannedGate:plannedGate??null,plannedFato:plannedFato??null,
  planned:Boolean(planned||flight),assigned:Boolean(assigned),instruction:state?.instruction?.reason??state?.instruction?.clearance_reason??state?.instruction?.action??null,
  decision:state?describePilotDecision({state,clearance:c}):null,
  geometryAvailable:Boolean(frame),
  places:frame?['gates','fatos'].flatMap(kind=>(layout[kind]??[]).filter(p=>p.center_m?.length===2&&p.center_m.every(finite)).map(p=>({...point(p.center_m),id:p.id,kind:kind==='gates'?'gate':'fato',radius:p.radius_m??5}))):[],
  paths:frame?(layout.edges??[]).map(e=>(e.points_m??[]).filter(p=>p?.length===2&&p.every(finite)).map(point)):[]};
}
// Far approach: draw the destination deck at useful scale, with a truthful
// off-chart ownship cue. Close to the deck, resume the familiar ownship centre.
export function surfaceOrigin(chart,position){return chart?.center&&surfaceDistance(chart.center,position)>250?chart.center:position;}

// The ranges the ground view offers, in kilometres. A deck is 70 to 140 m
// across, so the useful steps sit close together; the widest is only there to
// find a deck the aircraft is not standing on yet.
export const GROUND_RANGES_KM=[.05,.075,.1,.15,.2,.4];

// The smallest offered range that still holds a whole deck, seen from where
// the aircraft is standing. A fixed range cannot do this: the decks in use run
// from 70 to 140 m across and the aircraft is usually parked at one edge of
// one, so 200 m drew every deck as a knot in the middle of the rose.
export function fitGroundRangeKm(chart,position,ranges=GROUND_RANGES_KM) {
  const steps=[...(ranges??[])].filter(km=>Number.isFinite(km)&&km>0).sort((a,b)=>a-b);
  if(!steps.length)return null;
  if(!chart||!Number.isFinite(position?.latitude_deg)||!Number.isFinite(position?.longitude_deg))return null;
  const cos=Math.cos(position.latitude_deg*Math.PI/180);
  const metres=point=>{
    if(!Number.isFinite(point?.latitude_deg)||!Number.isFinite(point?.longitude_deg))return 0;
    const north=(point.latitude_deg-position.latitude_deg)*111320;
    const east=((((point.longitude_deg-position.longitude_deg)+540)%360)-180)*111320*cos;
    return Math.hypot(east,north);
  };
  const reach=place=>metres(place)+(Number.isFinite(place.radius)?place.radius:0);
  // What this aircraft is taxiing between. Fitting to those rather than to the
  // whole deck is the difference between a legible chart and a knot of eight
  // stands: the far end of a deck is context the range button can still reach.
  const mine=(chart.places??[]).filter(place=>place.id===(place.kind==='gate'?chart.gate:chart.fato));
  let needed=0;
  for(const place of mine.length?mine:(chart.places??[]))needed=Math.max(needed,reach(place));
  if(!mine.length)for(const path of chart.paths??[])for(const point of path??[])needed=Math.max(needed,metres(point));
  if(!(needed>0))return null;
  for(const point of chart.taxiPath??[])needed=Math.max(needed,metres(point));
  // A tenth of the radius of clear air, so the outermost stand is inside the
  // rose rather than drawn on top of the compass ring.
  const wanted=needed*1.1/1000;
  return steps.find(km=>km>=wanted)??steps[steps.length-1];
}
