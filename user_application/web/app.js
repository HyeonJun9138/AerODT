import {arriveAtManualAircraft} from './domains/uam/cockpit/manual_assignment_arrival.js';
import {CockpitEntryScreen} from './domains/uam/cockpit/cockpit_entry_screen.js';
import {ManualFlightSession} from './domains/uam/cockpit/manual_flight_session.js?v=20260921-repeat-flight';
import {createAnalysisReader} from './domains/uam/analysis/operations_requests.js';
import {AircraftCameraPanel} from './aircraft_camera_panel.js';
import {AirframeCamera} from '/visualization/airframe_camera.js';
import {createPanel} from './panel_instances.js';
import {installWindowLaunchers} from './window_launchers.js';
import {SelectionWindows} from './selection_windows.js';
import {WindowWorkspace} from './window_workspace.js?v=20260914-workspace';
import {ReplayPresentation} from './replay_presentation.js?v=20260917-manual-prediction';
import {TrajectoryLayer} from '/visualization/trajectory_layer.js';
import {HoldingBayLayer} from '/visualization/holding_bay_layer.js';
import {loadCockpitProfiles} from './domains/uam/cockpit/cockpit_profiles.js?v=20260917-ground-controls';
import {CockpitView} from './domains/uam/cockpit/cockpit_view.js?v=20260921-repeat-flight';
import {CockpitCamera} from '/visualization/cockpit_camera.js?v=20260917-cockpit-reveal';
import {screenCorners,screenTransform} from '/visualization/cockpit_projection.js?v=20260914-cockpit';
import {CockpitStick} from '/visualization/cockpit_stick.js?v=20260917-hardware';
import {CockpitThrottle} from '/visualization/cockpit_throttle.js?v=20260917-hardware';
import {RiskRadarSelection} from './domains/uam/prediction/risk_selection.js';
import {SelectedEntityAudio} from '/visualization/selected_entity_audio.js?v=20260918-ui-cues';
import {EntitySoundControls,sceneSoundSample} from './domains/uam/audio/entity_sound_controls.js?v=20260918-ui-cues';
import {RiskRadar} from './domains/uam/prediction/risk_radar.js?v=20260915-injected';
import {readOperating} from './domains/uam/operations/operating_client.js';
import {OperatingEnvironment} from './domains/uam/operations/operating_environment.js';
import {DestinationLoading} from './destination_loading.js';
import {OperationsFocus} from './domains/uam/operations/operations_focus.js';
import {LiveGlobe} from '/visualization/globe.js?v=20260921-camera-departure-lights';
import {validateSnapshot} from '/communication/tracking_client.js';
import {WorkerTrackingClient} from '/communication/worker_tracking_client.js?v=20260911-epoch';
import {ViewReporter,postView} from '/communication/view_report.js';
import {LoadingPhases,smoothProgress} from './loading.js';
import {LoadingScreen} from './loading_screen.js?v=20260911-entry-stable';
import {DomainChooser} from './domains/domain_chooser.js';
import {prepareDomainEntry} from './domains/domain_entry.js';
import {DOMAINS,scopeSnapshot,scopedLibraryApi} from './domains/domain_catalog.js';
import {SatelliteWorkspace,earthView} from './domains/satellite/workspace.js';
import {startStartupResources,loadStartupEngine,loadStartupStylesheet} from './startup_resources.js';
import {SelectionPanel} from './selection_panel.js?v=20260911-no-mission-notice';
import {AircraftDashboard} from './aircraft_dashboard.js?v=20260917-mfd-focus-idle';
import {FocusMode} from './focus_mode.js';
import {NoticeFeed,formatUtcClock} from './hud.js';
import {WorkPanel} from './work_panel.js';
import {OperationsAnalysis} from './domains/uam/analysis/operations_analysis.js?v=20260911-ops1';
import {PredictionPanel} from './domains/uam/prediction/prediction_panel.js?v=20260914-replay-fix';
import {SimulationPanel} from './domains/uam/planning/simulation_panel.js';
import {LibraryPanel} from './library_panel.js';
import {browserDisplaySettings} from './browser_display_settings.js';
import {LiveTwinningPanel} from './domains/uam/live_twinning/live_twinning_panel.js?v=20260911-light-flow';
import {StakeholderPanel} from './domains/uam/operations/stakeholder_panel.js?v=20260911-role-workspace';
import {AiModelLibrary} from './ai_model_library.js';
import {VertiportPanel} from './domains/uam/operations/vertiport_panel.js?v=20260913-info-focus';
import {OperationsSession} from './domains/uam/operations/operations_session.js';
import {RoleBadge} from './domains/uam/operations/role_mode.js';
import {PsuPanel} from './domains/uam/operations/psu_panel.js?v=20260911-role-workspace';
import {DecisionPanel} from './domains/uam/operations/decision_panel.js';
import {DeckDetail} from './domains/uam/operations/deck_detail.js?v=20260911-workspace';
import {IntruderInjector} from './intruder_injection.js?v=20260915-injected';
import {PerceptionTracks} from './camera_perception.js';
import {ModelLibrary} from './model_library.js';
import {rotateLayout} from '/visualization/vertiport_paint.js?v=20260917-pilot-detail';
import {facadePlan} from '/visualization/vertiport_shell.js';
import {cladHeight,podiumHeight} from '/visualization/vertiport_base.js?v=20260917-base';
import {paintThumbnail} from '/visualization/vertiport_thumbnail.js';
import {PlaceMenu} from './place_menu.js';
import {RoutePanel} from './domains/uam/planning/route_panel.js';
import {PlanPanel} from './domains/uam/planning/plan_panel.js?v=20260917-landing-fix';
import {DemandPanel} from './domains/uam/planning/demand_panel.js';
import {ScenarioControl} from './domains/uam/operations/scenario_control.js';
import {ManualAssignmentPanel} from './domains/uam/cockpit/manual_assignment_panel.js?v=20260917-day-manual';
import {ScenarioVertiportMonitor} from './domains/uam/operations/scenario_stakeholders.js?v=20260911-role-workspace';
import {DemandSummary} from './domains/uam/planning/demand_summary.js';
import {SchedulingProgress} from './domains/uam/planning/scheduling_progress.js';
import {PilotPanel} from './domains/uam/operations/pilot_panel.js?v=20260911-workspace';
import {labelSizeSetting} from './label_size.js';
import {displayQualitySetting} from './display_settings.js';
import {performanceSettings} from './performance_settings.js?v=20260917-frame-choice';
import {performanceProfile,PERFORMANCE_LIMITS} from '/visualization/performance_profile.js';
import {providerSetting} from './provider_settings.js';
import {sliderSetting} from './slider_setting.js';
import {ChangeWatch} from './change_watch.js';
import {RouteCard} from './domains/uam/planning/route_card.js';
import {UamDisplayMenu} from './domains/uam/planning/uam_display_menu.js';
import {UamPredictionControls} from './domains/uam/prediction/uam_prediction_controls.js?v=20260917-external';
const $ = id => document.getElementById(id);
const notices=new NoticeFeed();
function notify(channel,status,message) {
  if(!notices.update(channel,status,message))return;
  $('notices').replaceChildren(...notices.entries.map(entry=>{
    const li=document.createElement('li'),time=document.createElement('time'),text=document.createElement('span');
    li.dataset.status=entry.status;time.dateTime=new Date(entry.time).toISOString();time.textContent=time.dateTime.slice(11,19);
    text.textContent=entry.message;text.title=entry.message;li.append(time,text);return li;
  }));
}
// While a scheduled day is on the map the twin is not at "now", and a clock
// that says otherwise is the one thing on screen that would be lying. It is
// assigned once the console exists and answers null whenever the twin is back
// on the live clock.
let twinClockMillis=()=>null;
// What the tag beside the clock says for each mode. 'live' has no tag: the
// plain operator view is the one that needs no announcing.
const CLOCK_MODES={scenario:'SIMULATION',psu:'PSU',vertiport:'버티포트'};
function paintClock() {
  const replayed=twinClockMillis();
  const time=replayed ?? Date.now();
  const element=$('state-time');
  element.textContent=formatUtcClock(time)+(replayed?' · 재생':'');
  element.dateTime=new Date(time).toISOString();
  element.dataset.source=replayed?'scenario':'live';
  // The mode is said in a word as well as in colour: a ring around the clock is
  // only a decoration until something on screen names what it means.
  //
  // Holding a stakeholder seat wins the ring over a replayed day. Both change
  // what the screen is, but a seat changes what it answers as, and the time
  // itself already ends with '· 재생' when a day is being replayed.
  const clock=$('clock'),tag=$('clock-mode');
  const role=$('role-badge')?.dataset.role || '';
  // One flight being scrubbed is a simulation on screen just as a whole day is,
  // so it wears the same ring. Its console exists only while it is showing,
  // which is the same thing being asked.
  const replaying=replayed || Boolean(document.getElementById('flight-console'));
  const mode=CLOCK_MODES[role] ? role : replaying ? 'scenario' : 'live';
  clock.dataset.mode=mode;
  tag.textContent=CLOCK_MODES[mode] ?? '';
  tag.hidden=mode==='live';
}
paintClock();$('copyright-year').textContent=String(new Date().getUTCFullYear());
const clockInterval=setInterval(paintClock,100);
window.addEventListener('pagehide',()=>clearInterval(clockInterval),{once:true});
let transportStatus='connecting';
function connectionStatus(status,message) {
  $('transport-status').dataset.status=status;$('transport-status').textContent=message;
  if(status!==transportStatus)notify('transport',status,message);
  transportStatus=status;
  livePanel.setTransport(status);workWindows?.setTransport(status);
}
const phases = new LoadingPhases(['library','imagery','terrain','globe','assets','snapshot','display'],{library:15,imagery:15,terrain:15,globe:15,assets:10,snapshot:20,display:10});
const startupController=new AbortController();
const loadingScreen=new LoadingScreen({root:$('loading'),progress:$('loading-progress'),status:$('loading-step'),retry:$('retry')});
// Aircraft are requested for the area on screen, not the whole globe.
const viewReporter=new ViewReporter({send:postView()});
let shownProgress=0,lastProgress=performance.now(),bootFinished=false,progressFrame;
function paintProgress(now) {
  if(bootFinished)return;
  shownProgress=smoothProgress(shownProgress,phases.percent,now-lastProgress);lastProgress=now;
  loadingScreen.paint(shownProgress,phases.percent);
  if(!bootFinished)progressFrame=requestAnimationFrame(paintProgress);
}
progressFrame=requestAnimationFrame(paintProgress);
window.addEventListener('pagehide',()=>{startupController.abort();bootFinished=true;cancelAnimationFrame(progressFrame);loadingScreen.destroy();},{once:true});
function report(key, message) {phases.complete(key);loadingScreen.setStatus(message);}
function warning(message) {notify('warning',message,message);}
function loadCesium() {
  return startupResources.engine;
}
async function getJSON(url,{signal,method='GET',headers,body,timeoutMs=12000}={}) {
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try {
    const response=await fetch(url,{signal:controller.signal,cache:'no-store',method,headers,body});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
// Engine, catalogue and first state overlap with each other and shell setup.
const startupResources=startStartupResources({signal:startupController.signal,loadJSON:getJSON,
  loadEngine:options=>Promise.all([loadStartupEngine({document,...options}),loadStartupStylesheet({document,...options})])});
$('retry').onclick=()=>location.reload();
// The application shell does not wait for the map: the work-area rail, the
// target chips and the settings panel are usable even in limited mode.
const workPanel=new WorkPanel({root:$('drawer'),title:$('drawer-title'),body:$('drawer-body'),
  owner:document.body,buttons:{live:$('mode-live'),simulation:$('mode-simulation'),library:$('mode-library'),stakeholders:$('mode-stakeholders'),analysis:$('mode-analysis')}});
const windowWorkspace=new WindowWorkspace({document,window,notify:message=>notify('window-layout','warning',message)}).start();
window.addEventListener('pagehide',()=>windowWorkspace.destroy(),{once:true});
// The map is created later; the shell only forwards to it once it exists.
let liveGlobe=null,workWindows=null;
let activeDomain=null;
const satelliteWorkspace=new SatelliteWorkspace({document,workspace:windowWorkspace});
window.addEventListener('pagehide',()=>satelliteWorkspace.destroy(),{once:true});
let operationsAnalysis=null;
let riskRadar=null,riskSelection=null;
// Obstacles the operator asks for. Held by the shell because the snapshot they
// are added to is the shell's, and read by the camera panel that launches them.
const intruders=new IntruderInjector();
// What the camera's detector has placed in the world: joins the snapshot the
// same way, so the map and the risk panel list it as perception.
const perception=new PerceptionTracks();
function openRiskSettings(){
  const panel=workWindows.open('live').controller.panel;
  void panel.ready.then(()=>panel.openSettings('ai_models','risk_prediction'));
}
// What the traffic radar can be opened for. The same list the detail window
// shows its own button for, so the strip, the drawer and the window agree.
const RADAR_KINDS=['uam','aircraft','helicopter','drone'];
function openRiskRadar(id){
  const entities=riskRadar?.snapshot?.entities??[];
  const key=id||riskRadar?.entityId||liveGlobe?.selected;
  const entity=entities.find(e=>e.entity_id===key)||entities.find(e=>e.entity_id===`physical:${key}`)||entities.find(e=>e.entity_id===`scenario:${key}`);
  if(!entity){
    // Two different misses: nothing chosen, or something chosen that the live
    // traffic wire does not carry — a replayed flight is drawn from a record.
    notify('risk:selection','waiting',key
      ?'이 비행은 실시간 교통 수신에 없어 주변 레이더를 열 수 없습니다.'
      :'주변을 확인할 비행체를 먼저 선택하세요.');
    return;
  }
  riskSelection.open(entity);
}
async function sendJSON(method,url,body) {
  const response=await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw Object.assign(new Error(data?.message || `HTTP ${response.status}`),{data});
  return data;
}
const getOperatingJSON=url=>readOperating(getJSON,url);
let operatingEnvironment=null;
const simulationApi={
  editState:()=>getJSON('/api/simulation/vertiports/edit-state'),
  heightPreview:(id,values)=>liveGlobe?.previewVertiportHeights(id,values),
  heightConflicts:reports=>liveGlobe?.showVertiportHeightConflicts(reports),
  checkHeights:async(id,heights)=>{
    const request=await liveGlobe?.routeConflictRequest(null,{vertiportId:id,heights});
    const links=request?.links??[];if(!links.length)return {links:{}};
    const reports={};
    for(let i=0;i<links.length;i+=8){const answer=await routeApi.conflicts({links:links.slice(i,i+8),cleared:request.cleared??[]});Object.assign(reports,answer.links??{});}
    return {links:reports};
  },
  list:()=>getJSON('/api/simulation/vertiports'),
  // The wire wraps one record; the panels want the record.
  get:async id=>(await getJSON(`/api/simulation/vertiports/${encodeURIComponent(id)}`))?.vertiport ?? null,
  options:()=>getJSON('/api/simulation/vertiports/options'),
  preview:definition=>sendJSON('POST','/api/simulation/vertiports/preview',definition),
  create:definition=>sendJSON('POST','/api/simulation/vertiports',definition),
  update:(id,definition)=>sendJSON('PUT',`/api/simulation/vertiports/${encodeURIComponent(id)}`,definition),
  remove:async id=>{const response=await fetch(`/api/simulation/vertiports/${encodeURIComponent(id)}`,{method:'DELETE',signal:AbortSignal.timeout(12000)});
    if(!response.ok && response.status!==404)throw new Error(`HTTP ${response.status}`);},
};
const routeApi={
  network:()=>getJSON('/api/simulation/routes'),
  options:()=>getJSON('/api/simulation/routes/options'),
  place:(latitude,longitude)=>getJSON(`/api/simulation/routes/place?latitude=${encodeURIComponent(latitude.toFixed(6))}&longitude=${encodeURIComponent(longitude.toFixed(6))}`),
  createNode:definition=>sendJSON('POST','/api/simulation/routes/nodes',definition),
  updateNode:(id,definition)=>sendJSON('PUT',`/api/simulation/routes/nodes/${encodeURIComponent(id)}`,definition),
  removeNode:async id=>{const response=await fetch(`/api/simulation/routes/nodes/${encodeURIComponent(id)}`,{method:'DELETE',signal:AbortSignal.timeout(12000)});
    if(!response.ok && response.status!==404)throw new Error(`HTTP ${response.status}`);},
  createLink:definition=>sendJSON('POST','/api/simulation/routes/links',definition),
  updateLink:(id,definition)=>sendJSON('PUT',`/api/simulation/routes/links/${encodeURIComponent(id)}`,definition),
  removeLink:async id=>{const response=await fetch(`/api/simulation/routes/links/${encodeURIComponent(id)}`,{method:'DELETE',signal:AbortSignal.timeout(12000)});
    if(!response.ok && response.status!==404)throw new Error(`HTTP ${response.status}`);},
  // A batch of links against the buildings under them: the server may have to
  // fetch the cells first, so this one waits longer than a form save.
  conflicts:async body=>{
    const response=await fetch('/api/simulation/routes/conflicts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
    const data=await response.json().catch(()=>null);
    if(!response.ok)throw Object.assign(new Error(data?.message || `HTTP ${response.status}`),{data,status:response.status});
    return data;
  },
};
// Chips open display menus; opening one never changes layer visibility.
let uamStorage;try{uamStorage=window.localStorage;}catch{}
const displayMenus=[];
const openDisplayMenu=current=>{for(const menu of displayMenus)if(menu!==current)menu.open(false);};
const uamMenu=new UamDisplayMenu({button:$('layer-uam'),mount:$('layers'),storage:uamStorage,
  onChange:state=>{if(activeDomain==='uam')liveGlobe?.setUamDisplay(state);},onOpen:openDisplayMenu});
const uamPredictionControls=new UamPredictionControls({
  onChange:async(name,value)=>{
    await livePanel.ready;
    if(!livePanel.values?.uam_prediction)return false;
    const answer=await libraryApi.apply({sources:{uam_prediction:{[name]:value}}});
    if(!answer.values?.uam_prediction)return false;
    libraryPanel.onDisplay('uam_prediction',answer.values.uam_prediction);
    return true;
  },
  onSettings:()=>{
    uamMenu.open(false);
    const panel=workWindows.open('live').controller.panel;
    void panel.ready.then(()=>panel.openSettings('ai_models','uam_prediction'));
  }
});
uamMenu.root.append(uamPredictionControls.root);

displayMenus.push(uamMenu);
const entityMenus=Object.fromEntries([['aircraft','항공기'],['satellite','위성']].map(([kind,title])=>{
  const menu=new UamDisplayMenu({button:$(`layer-${kind}`),mount:$('layers'),storage:uamStorage,id:kind,title,
    defaults:{all:true,labels:true,models:true},items:[['labels','이름표'],['models','3D 모델']],
    note:'3D 모델을 끄면 점·아이콘으로 표시합니다. 개수는 현재 수신 범위 기준이며, 숨겨도 데이터 수신은 계속됩니다.',
    onChange:state=>{if(DOMAINS[activeDomain]?.kinds.includes(kind))liveGlobe?.setEntityDisplay(kind,state);},onOpen:openDisplayMenu});
  displayMenus.push(menu);return [kind,menu];
}));
window.addEventListener('pagehide',()=>displayMenus.forEach(menu=>menu.destroy()),{once:true});
// The placement tools open on the map where the operator right-clicks, so they
// sit over the page rather than inside the work panel.
const placeMenu=new PlaceMenu({mount:document.body,
  // What a deck this tall becomes: the base storey the colonnade stands in,
  // and the clad storeys above it — the building the map actually draws.
  describeHeight:metres=>{const base=podiumHeight(metres),storeys=facadePlan(cladHeight(metres)).storeys;
    if(base>0)return storeys?`기단 ${base} m + 외벽 ${storeys}층`:`기단 ${base} m`;
    return storeys?`외벽 ${storeys}층`:'외벽 없음 (판만)';},
  onChange:(name,value)=>simulationPanel.toolChanged(name,value),
  onPlace:()=>simulationPanel.placeWithTools(),onResume:()=>simulationPanel.resumeTools()});
// Cards open on the map where the operator clicked, like the placement tools:
// one for the route editor, one for the vertiport a click landed on.
const routeCard=new RouteCard({mount:document.body});
const vertiportCard=new RouteCard({mount:document.body});
const routePanel=createPanel(RoutePanel,{api:routeApi,notify:(status,message)=>notify(`route:${message}`,status,message),card:routeCard,
  onNetwork:(network,segments)=>{if(operatingEnvironment?.source==='scenario')void liveGlobe?.showRoutes(network,segments);else void operatingEnvironment?.refresh();},
  onSelect:(id,blocked)=>liveGlobe?.selectRouteNode(id,blocked),onPreviewLink:(from,to)=>liveGlobe?.previewRouteLink(from,to),onEditing:editor=>liveGlobe?.setRouteEditor(editor),onFocus:id=>liveGlobe?.flyToRouteNode(id),
  onMoveNode:(id,pose)=>liveGlobe?.moveRouteNode(id,pose),
  groundAt:async point=>{const heights=await liveGlobe?.groundHeights([point]);return Number.isFinite(heights?.[0])?heights[0]:null;},
  positionOf:id=>liveGlobe?.routePosition(id) ?? null,screenOf:place=>liveGlobe?.screenOf(place) ?? null,
  // The building check: the map says where each link stands and what the ground
  // does under it; the server measures; the map draws what it said.
  conflictRequest:ids=>liveGlobe?.routeConflictRequest(ids) ?? null,onConflicts:reports=>liveGlobe?.showRouteConflicts(reports)});
// One test flight, built from the vertiports and the route network and played
// back on the map: the panel samples the plan and the map only moves.
const planApi={
  options:()=>getJSON('/api/simulation/plans/options'),
  prepare:definition=>sendJSON('POST','/api/simulation/plans',definition),
  // Flying is the Digital Layer's; the run it produces is the Data Layer's.
  // The page asks for one and reads its states back — the same shape a live
  // flight would take, so simulation mode and live mode look alike here.
  fly:definition=>sendJSON('POST','/api/simulation/runs',definition),
  runs:()=>getJSON('/api/simulation/runs'),
  states:runId=>getJSON(`/api/simulation/runs/${encodeURIComponent(runId)}/states`),
};
// The multi-flight setup: which vertiports, how much demand between which of
// them, when the day runs, which seed and what stands on the decks. The
// generator that turns it into flights is being written separately; until it
// answers, the setup is still collected and can be saved to a file.
// Building a day takes long enough that one request would time out, so it is
// three: start it, ask how it is going, and read what it made. While it runs the
// whole screen goes behind one word that fills as the run does.
const schedulingProgress=new SchedulingProgress({document,mount:document.body});
const SCHEDULING_POLL_MS=450;
// Long enough that a full word is seen rather than glimpsed.
const SCHEDULING_HOLD_MS=1100;
// A dropped poll is not a failed run - the server is building, not gone - but a
// server that stops answering altogether has to be reported rather than spun on.
const SCHEDULING_MISSES=20;
const readable=value=>Number(value ?? 0).toLocaleString('ko-KR');
async function runScheduling(request){
  schedulingProgress.open('비행계획을 준비하는 중입니다');
  let started;
  try{
    started=await sendJSON('POST','/api/simulation/plans/multi',request);
  }catch(error){
    schedulingProgress.fail('비행계획을 만들지 못했습니다',error?.data?.message ?? error?.message ?? '');
    throw error;
  }
  schedulingProgress.set({percent:started?.percent,message:started?.message});
  let missed=0;
  for(;;){
    await new Promise(resolve=>setTimeout(resolve,SCHEDULING_POLL_MS));
    let state=null;
    try{state=await getJSON('/api/simulation/plans/multi/status');missed=0;}
    catch(error){
      missed+=1;
      if(missed<SCHEDULING_MISSES)continue;
      schedulingProgress.fail('생성 상태를 읽지 못했습니다','서버 연결을 확인해 주세요.');
      throw error;
    }
    if(state.state==='error'){
      schedulingProgress.fail('비행계획을 만들지 못했습니다',state.error ?? '');
      throw Object.assign(new Error(state.error || '비행계획을 만들지 못했습니다'),{data:state});
    }
    schedulingProgress.set({percent:state.percent,message:state.message,
      note:[state.summary?`비행 ${readable(state.summary.flights)}편 · 탑승 ${readable(state.summary.carried_passengers)}명`:'',
        Number.isFinite(state.elapsed_s)?`전체 ${Math.floor(state.elapsed_s)}초 · 현재 단계 ${Math.floor(state.phase_elapsed_s ?? 0)}초`:''].filter(Boolean).join(' · ')});
    schedulingProgress.setStages(state.stages);
    if(state.state==='done'){
      schedulingProgress.setStages(state.stages);
      schedulingProgress.done('비행계획을 적용했습니다');
      setTimeout(()=>schedulingProgress.close(),SCHEDULING_HOLD_MS);
      return state;
    }
  }
}
const demandApi={
  list:simulationApi.list,
  // How much of a day each deck carries before anybody changes it, from the
  // travel-demand shares we were given.
  demandDefaults:()=>getJSON('/api/simulation/demand/defaults'),
  // The generated day is loaded by the server before it says it is done, so
  // what comes back here is a day already on the decks: it is handed to the
  // panel exactly as the example one is.
  generate:async request=>{
    const state=await runScheduling(request);
    return {flights:state.summary?.flights ?? 0,summary:state.summary,applied:state.applied ?? null,
      notes:state.notes ?? []};
  },
};
// A day somebody else planned, read from a file. The server holds the day and
// the clock; this hands the file over and asks for the controls.
const scenarioApi={
  example:()=>sendJSON('POST','/api/simulation/scenario/example',{}),
  describe:()=>getJSON('/api/simulation/scenario'),
  status:()=>getJSON('/api/simulation/scenario/status'),
  control:body=>sendJSON('POST','/api/simulation/scenario/control',body),
  vertiport:id=>getJSON(`/api/simulation/scenario/vertiports/${encodeURIComponent(id)}`),
  aircraft:id=>getJSON(`/api/simulation/scenario/aircraft/${encodeURIComponent(id)}`),
  // Throw the day away. Closing the console hands the twin back; this is the
  // separate act of saying the day itself is finished with.
  unload:async()=>{const response=await fetch('/api/simulation/scenario',{method:'DELETE',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();},
};
const operatingApi={
  status:()=>getOperatingJSON('/api/operations/context/status'),
  vertiport:id=>getOperatingJSON(`/api/operations/context/vertiports/${encodeURIComponent(id)}`),
  aircraft:id=>getOperatingJSON(`/api/operations/context/aircraft/${encodeURIComponent(id)}`),
  list:()=>getOperatingJSON('/api/operations/context/environment'),
  get:async id=>(await getOperatingJSON('/api/operations/context/environment')).vertiports?.find(p=>p.id===id)??null,
};
// How fast a UAM is flown. The pilot sets it; the whole dashboard builds to it.
const operatingProfileApi={
  operations:()=>getOperatingJSON('/api/operations/context/pilots'),
  read:()=>getOperatingJSON('/api/operations/context/profile'),
  write:values=>sendJSON('PUT','/api/simulation/operating-profile',{values}),
  reset:()=>sendJSON('POST','/api/simulation/operating-profile/reset',{}),
};
const pilotPanel=createPanel(PilotPanel,{api:operatingProfileApi,document,onRisk:id=>openRiskRadar(id),
  onOpen:()=>{focusMode.set(false);},
  onDecisions:()=>void decisionPanel.open('pilot'),
  notify:(status,message)=>notify(`pilot:${message}`,status,message)});
// The console for that day. It is created once and drawn only when the operator
// opens it, so nothing of it exists on a session that never loads a plan.
const scenarioControl=new ScenarioControl({api:scenarioApi,mount:document.body,
  displayClock:()=>{
    const samples=liveGlobe?.entityScene?.samples;
    return samples?.hasClockRate?samples.clockTime(performance.now())*1000:null;
  },
  notify:(status,message)=>notify(`scenario:${message}`,status,message),
  onFocusMode:()=>focusMode.set(true),
  onCapture:name=>liveGlobe?.captureImage(name) ?? false,
  onRecord:(action,name)=>action==='start'?(liveGlobe?.startRecording(name) ?? false):(liveGlobe?.stopRecording() ?? false),
  // While a day is on the map the live traffic is not, so the layer chips would
  // be reporting on something that is not there.
  onOpen:()=>{document.body.setAttribute('data-scenario','open');liveGlobe?.ownSource?.('scenario');
    liveGlobe?.setScenarioPassengers?.(true);paintClock();},
  // The day stops being the twin's state the moment the console closes, so it
  // stops being on the map then too rather than whenever the wire catches up.
  // Closing is done with the day, not a pause: the twin goes back to the live
  // clock, the aircraft come off the map, and the plan is thrown away so
  // nothing on screen goes on offering a replay that is over. Pausing is what
  // keeps a day.
  onClose:()=>{document.body.removeAttribute('data-scenario');liveGlobe?.dropSource?.('scenario');
    liveGlobe?.setScenarioPassengers?.(false);paintClock();
    demandPanel.forgetPlan();demandSummary.close();}});
twinClockMillis=()=>scenarioControl.clockMillis();
// Being handed one aircraft of the running day. The panel only chooses; the
// session that follows is the same manual flight as any other, told which
// airframe it is instead of which saved plan.
// Up from the moment the day hands an airframe over until the seat is ready, so
// the socket handshake, the model load and the camera being placed all happen
// behind one surface instead of in front of the operator.
const cockpitEntry=new CockpitEntryScreen({document,window});
const manualAssignment=new ManualAssignmentPanel({
 api:{
  offers:()=>getJSON('/api/simulation/scenario/manual/offers'),
  assign:body=>sendJSON('POST','/api/simulation/scenario/manual/assign',body),
  release:body=>sendJSON('POST','/api/simulation/scenario/manual/release',body)},
 notify:(status,message)=>notify('manual-assign',status,message),
 onAssigned:async assignment=>{
  cockpitEntry.show(assignment);
  try{
   // A stand-in plan with the one thing the page needs before the socket opens:
   // where the aircraft is standing. The day sends the real one back on ready.
   const height=Number.isFinite(assignment.altitude_m)?assignment.altitude_m:0;
   await manualFlight.start({aircraft_id:assignment.aircraft_id,
    plan:{control_mode:'manual',legs:[{path:[[assignment.longitude,assignment.latitude,height]]}],
     totals:{battery_start_pct:100},
     vehicle:{passengers:assignment.flight?.passengers??0,capacity:assignment.seats??4}}});
  }catch(error){
   // The screen clears itself after saying this, so no failure can leave the
   // map covered -- and the notice below is still where the message lives.
   cockpitEntry.fail(error.message);
   notify('manual-assign','warning',error.message);
   manualAssignment.forget();
   void sendJSON('POST','/api/simulation/scenario/manual/release',{aircraft_id:assignment.aircraft_id}).catch(()=>{});
  }
 },
 onReleased:()=>manualFlight.stop(false)});
scenarioControl.setManualPanel(manualAssignment);
window.addEventListener('pagehide',()=>{
  if(scenarioControl.isOpen&&!new URLSearchParams(location.search).has('diagnostics'))void fetch('/api/simulation/scenario/control',{method:'POST',keepalive:true,
    headers:{'content-type':'application/json'},body:JSON.stringify({action:'close_control'})}).catch(()=>{});
  scenarioControl.destroy();
},{once:true});
// Five steps of settings and a request that takes minutes to build: the button
// opens a summary of the whole thing first, and asks for it from there.
const demandSummary=createPanel(DemandSummary,{document,mount:document.body,
  notify:(status,message)=>notify(`demand:${message}`,status,message)});
window.addEventListener('pagehide',()=>demandSummary.destroy(),{once:true});
const demandPanel=createPanel(DemandPanel,{api:demandApi,notify:(status,message)=>notify(`demand:${message}`,status,message),
  plans:scenarioApi,
  onSummary:(view,actions)=>demandSummary.open(view,actions),
  // Loading a day does not hand the map over to it: it only tells the map how
  // big each cabin is drawn, so the fleet is the right size the moment the
  // operator does hand it over.
  onPlanLoaded:(answer,manual)=>{liveGlobe?.setModelSpans(answer?.schedule?.model_spans);
    if(!manualFlight.running){manualAssignment.setRequest(manual);
      if(scenarioControl.isOpen)void scenarioControl.refresh();}},
  onManualRequest:request=>{
    if(manualFlight.running)return;
    manualAssignment.setRequest(request);
    if(scenarioControl.isOpen)void scenarioControl.refresh();
  },
  // The plan says whether one aircraft of this day is to be flown by hand, and
  // which kind from where. The console only reports whether that flight has
  // come round yet.
  onControlPanel:(plan,manual)=>{
    // The other direction of the same rule: a single flight already on screen
    // has the globe, and a day opening beside it would put two sets of aircraft
    // on one map. Said by name, with what to do about it.
    if(planPanel.plan){
      notify('scenario','warning','단일 비행이 화면에 있습니다. 「계획 취소 · 화면에서 제거」로 정리한 뒤 다중 비행을 여세요.');
      return null;
    }
    manualAssignment.setRequest(manual);return scenarioControl.open();
  },
  onPairs:(pairs,options)=>liveGlobe?.showDemandPairs(pairs,options),
  onDemandEditor:editor=>liveGlobe?.setDemandEditor(editor),
  onQuiet:active=>liveGlobe?.setDemandFocus(active),
  onScrap:scrap=>{if(scrap)liveGlobe?.beginScrap(scrap);else liveGlobe?.cancelScrap();},
  onFocus:record=>{if(liveGlobe)liveGlobe.flyToVertiport(record.layout?.frame ?? record);}});
// 시야 집중 모드: one switch, offered by both consoles and by the round control
// beside the clock, so the state can never disagree with itself.
const focusMode=new FocusMode({document,onChange:on=>{
  aircraftDashboard?.setFocusMode(on);
  // Entering focus mode starts following whatever is selected, but never
  // re-frames a cockpit or external camera that is already riding with it: that reads as the view
  // running away from the thing being watched.
  if(on&&liveGlobe&&!liveGlobe.cockpit?.active&&!liveGlobe.tracking&&!liveGlobe.approaching)liveGlobe.focus(true);
}}).attach();
window.addEventListener('pagehide',()=>focusMode.destroy(),{once:true});
let replayPresentation=null,replayTrajectory=null;
// Entering manual flight takes the workspace apart: the dashboard is minimised,
// the plan and Simulation windows are put away, the flight is picked. Leaving
// has to put back exactly what it moved and nothing else -- a window the
// operator had already minimised themselves stays that way.
let manualStowed=[],manualDashboardWasOpen=false,manualScenarioWasOpen=false,manualFleetActive=false;
// The bay the service reserved for this pilot, drawn on the map. Built once the
// globe exists, which is after this session object is; a hold that arrives
// before then is drawn on the next sample, a frame later.
let holdingBay=null;
const holdingBayLayer=()=>{
  if(!holdingBay&&liveGlobe?.C&&liveGlobe?.viewer)
    holdingBay=new HoldingBayLayer(liveGlobe.C,liveGlobe.viewer,
      {read:()=>manualFlight.readPsu()?.hold,aircraft:()=>manualFlight.sample});
  return holdingBay;
};
const manualFlight=new ManualFlightSession({
 onSound:kind=>document.dispatchEvent(new CustomEvent('aerodt:sound-cue',{detail:{kind}})),
 onClear:()=>{holdingBay?.clear();liveGlobe?.entityScene?.setManualSample(null,null);},
 contactDecks:async()=>{await liveGlobe?.portsReady;return liveGlobe?.vertiportLayer?.contactDecks()??[];},
  // One airframe of the running day is drawn by the day itself -- the pose goes
  // to the server and comes back with the fleet. Drawing the single-flight
  // preview as well would put two of the same aircraft in the same place.
  onSample:sample=>{manualFlight.sample=sample;holdingBayLayer()?.update();if(manualFlight.twin){liveGlobe?.entityScene?.setManualSample(`scenario:${manualFlight.twin}`,sample,manualFlight.plan);return;}liveGlobe?.moveFlight(sample);planPanel.acceptManualSample(sample);},
  onTelemetry:sample=>!manualFlight.twin&&replayPresentation?.update({plan:planPanel.plan,run:{run_id:manualFlight.run_id??'manual'},sample}),
 onReady:async()=>{
   manualFleetActive=Boolean(manualFlight.twin);
   manualDashboardWasOpen=aircraftDashboard?.minimised===false;
   manualScenarioWasOpen=Boolean(scenarioControl.isOpen&&!scenarioControl.minimised);
   if(manualScenarioWasOpen)scenarioControl.setMinimised(true);
   manualStowed=[];
   for(const entry of windowWorkspace.entries.values())
     if((entry.node.contains(planPanel.formSlot)||entry.title.textContent==='Simulation')&&!entry.minimized){
       manualStowed.push(entry.node);windowWorkspace.minimize(entry);
     }

   // Glide in, then settle. flyToFlight on its own arrives as fast as the range
   // motion allows, which from far out is a lurch; the glide takes a second or
   // two and the settle only re-establishes the follow anchor, with no motion
   // left to make. The aircraft is parked at this point, so aiming at the
   // sample that has arrived by the end keeps the framing honest.
   // An airframe of the day is an ordinary scenario entity, and the cockpit
   // already knows how to enter one of those. The single-flight preview is for
   // a flight of its own; using it here would draw a second aircraft.
   if(manualFlight.twin){
     const aircraftId=manualFlight.twin,generation=manualFlight.generation;
     try{
       await arriveAtManualAircraft({aircraftId,getGlobe:()=>liveGlobe,
         isCurrent:()=>manualFlight.running&&manualFlight.generation===generation&&manualFlight.twin===aircraftId,
         onProgress:text=>{manualFlight.panel.setStatus('preparing','준비 중',text);cockpitEntry.advance(text);}});
     }catch(error){cockpitEntry.fail(error.message);throw error;}
     // Only once the seat is taken: what is behind the screen is the cockpit.
     cockpitEntry.hide();
     aircraftDashboard?.setMinimised(true);manualFlight.panel.mountDashboard(aircraftDashboard);
     return;
   }
   if(manualFlight.sample){
     await liveGlobe?.flyToFlightSmoothly(manualFlight.sample);
     liveGlobe?.flyToFlight(manualFlight.sample);
   }
   const deadline=performance.now()+15000;
   while(performance.now()<deadline){
     if(liveGlobe?.cockpit?.singleUsable()){
       if(!liveGlobe.cockpit.enterSingle())throw new Error('조종석 진입 불가: 3D 시점과 기체 모델을 확인하세요.');
       replayPresentation?.pick();
       aircraftDashboard?.setMinimised(true);manualFlight.panel.mountDashboard(aircraftDashboard);
       return;
     }
     await new Promise(resolve=>setTimeout(resolve,100));
   }
   throw new Error('조종석 모델 준비 시간 초과. 수동 세션을 종료했습니다.');
 },
 // 종료 ends the whole thing, because a manual flight is the single flight:
 // there is no recording left to scrub afterwards. Leaving any of this behind
 // was what read as the mode not ending -- a dead strip over a workspace whose
 // windows were still put away.
 onExit:()=>{
   liveGlobe?.cockpit?.exit();
   manualFlight.panel.close();
   const wasFleet=manualFleetActive;manualFleetActive=false;
   liveGlobe?.entityScene?.setManualSample(null,null);
   manualFlight.sample=null;
   for(const node of manualStowed)windowWorkspace.reveal(node);
   manualStowed=[];
   if(manualDashboardWasOpen)aircraftDashboard?.setMinimised(false);
   manualDashboardWasOpen=false;
   if(manualScenarioWasOpen&&scenarioControl.isOpen)scenarioControl.setMinimised(false);
   manualScenarioWasOpen=false;
   // The day handed the airframe back when the socket closed; the panel that
   // chose it follows rather than holding a stale assignment.
   manualAssignment.setRequest({want:false});
   if(!wasFleet)planPanel.clearFlight();
 },notify:message=>notify('manual-flight','warning',message),
 // The head switch on a stick looks around; the rest of it flies the aircraft
 // and never reaches here. A device unplugged mid-flight is worth saying out
 // loud -- the aircraft keeps its throttle and stops turning, which on its own
 // reads as the controls having gone dead.
 // The switch says where it is pushed; the globe turns the view on its own
 // render loop, because that is where the frames are.
 onLook:(x,y,speed,zoom)=>liveGlobe?.setLook(x,y,speed,zoom),
 onAction:(action,amount)=>{
   if(action==='find_aircraft'){
     const g=liveGlobe;if(!g)return;
     if(manualFlight.twin){
       const id=`scenario:${manualFlight.twin}`;
       if(!g.items.has(id)){notify('manual-flight','warning','내 기체 위치를 수신 중입니다. 잠시 후 다시 눌러 주세요.');return;}
       g.select(id);g.focus(true);
     // Finding my own aircraft flies the camera to it, so leaving the cockpit
     // must not put the camera back at the vertiport first and fly in from there.
     }else if(manualFlight.sample){g.cockpit?.exit(false,true);g.flyToFlight(manualFlight.sample);g.followFlight(manualFlight.sample);replayPresentation?.pick();}
   }
   else if(action==='view_reset')liveGlobe?.resetLook();
   else if(action==='device_lost')notify('manual-flight','warning','조이스틱 연결이 끊겼습니다. 스로틀은 유지되고 조종 입력은 중립입니다.');
   else if(action==='device_absent')notify('manual-flight','warning','조이스틱이 잡히지 않습니다. 설정 창에서 스틱 버튼을 한 번 눌러 주세요 — 창에 이유가 적힙니다.');
 }
});
window.addEventListener('pagehide',()=>manualFlight.destroy(),{once:true});
let planPanel=createPanel(PlanPanel,{api:planApi,demandPanel,onManual:args=>manualFlight.start(args),onManualStop:()=>manualFlight.stop(false),twinBusy:()=>scenarioControl.isOpen?'다중 비행이 실행 중입니다. 먼저 종료한 뒤 단일 비행을 시작하세요.':null,notify:(status,message)=>notify(`plan:${message}`,status,message),
  onPlan:plan=>{liveGlobe?.showFlightPlan(plan);if(!plan)liveGlobe?.clearHover();if(!plan)replayPresentation?.update(null);},
  onSample:sample=>{liveGlobe?.moveFlight(sample);replayPresentation?.update({plan:planPanel.plan,run:planPanel.run,sample});},
  onFocus:sample=>liveGlobe?.flyToFlight(sample),
  onFollow:(sample,options)=>{if(sample)liveGlobe?.followFlight(sample,options);else liveGlobe?.releaseFlight();},
  onFocusMode:()=>focusMode.set(true),
  onCockpit:()=>{if(!liveGlobe?.cockpit?.enterSingle())notify('single-cockpit','warning','조종석 모델 준비 중입니다. 기체가 표시된 뒤 다시 눌러 주세요.');},
  // The designed heights are stood on the terrain and the decks the map has,
  // so the flight follows the route exactly as it was drawn.
  groundHeights:points=>liveGlobe?liveGlobe.groundHeights(points):Promise.resolve(null),
  deckTop:id=>liveGlobe?.deckTopOf(id) ?? null});
window.addEventListener('pagehide',()=>planPanel.destroy(),{once:true});
let savedVertiportCount=0;
let simulationPanel=createPanel(SimulationPanel,{domainOnly:'uam',api:simulationApi,notify:(status,message)=>notify(`simulation:${message}`,status,message),routePanel,planPanel,
  card:vertiportCard,onVertiportEditor:editor=>liveGlobe?.setVertiportEditor(editor),
  screenOf:place=>liveGlobe?.screenOf(place) ?? null,
  onShow:records=>{savedVertiportCount=records.length;uamMenu.setCount(`버티포트 ${records.length.toLocaleString()}곳`);if(operatingEnvironment?.source==='scenario')void liveGlobe?.showVertiports(records);else void operatingEnvironment?.refresh();},
  onPreview:(layout,name)=>void liveGlobe?.previewVertiport(layout,name),
  onFocus:record=>{if(liveGlobe)liveGlobe.flyToVertiport(record.layout?.frame ?? record);},
  drawThumbnail:(layout,name,canvas)=>paintThumbnail(layout,name,canvas),
  onFollow:(layout,name,pose)=>liveGlobe?.followVertiport(layout,name,pose),
  onFollowMove:pose=>liveGlobe?.moveVertiportPreview(pose),rotateLayout,
  onEditing:id=>liveGlobe?.dimVertiport(id),
  pickLocation:options=>liveGlobe?liveGlobe.pickGroundOnce(options):Promise.resolve(null),
  cancelPick:()=>liveGlobe?.cancelGroundPick(),placeMenu,
  resumePick:()=>liveGlobe?.resumeGroundPick(),commitPick:pose=>liveGlobe?.commitGroundPick(pose)});
// The server is one machine with one set of files and several people may have
// this open. The page asks where the stored simulation data stands and reloads
// what it shows when the answer moves; it never asks for the data itself.
const changeWatch=new ChangeWatch({read:()=>getOperatingJSON('/api/operations/context/revision'),
  onChange:async()=>{await operatingEnvironment.refresh();await simulationPanel.refresh();await routePanel.refresh();}});
operatingEnvironment=new OperatingEnvironment({readRevision:()=>getOperatingJSON('/api/operations/context/revision'),read:()=>getOperatingJSON('/api/operations/context/environment'),globe:()=>liveGlobe,
  onChange:()=>{if(vertiportPanel.side||vertiportPanel.console)void vertiportPanel.refresh();pilotPanel.described=null;if(pilotPanel.console)void pilotPanel.load();if(decisionPanel.root)void decisionPanel.load();}});
const operationEnvironmentTimer=setInterval(()=>{if(activeDomain==='uam'&&!document.hidden)void operatingEnvironment.refresh();},2000);
window.addEventListener('pagehide',()=>{clearInterval(operationEnvironmentTimer);operatingEnvironment.close();},{once:true});
// It watches the stored data, not the map, so it starts with the shell and
// keeps working even when the globe never finishes loading.
const watchWhileVisible=()=>{if(activeDomain!=='uam'||document.hidden)changeWatch.stop();else changeWatch.start();};
document.addEventListener('visibilitychange',watchWhileVisible);
window.addEventListener('pagehide',()=>{document.removeEventListener('visibilitychange',watchWhileVisible);changeWatch.stop();},{once:true});
watchWhileVisible();
// The data library: source state and the acquisition settings the operator owns.
const browserDisplay=browserDisplaySettings({onStorageError:()=>{
  $('display-storage-note').textContent='브라우저 저장을 사용할 수 없어 현재 탭에만 적용됩니다.';
},api:{
  describe:()=>getJSON('/api/library/sources'),
  apply:patch=>sendJSON('PUT','/api/library/sources',patch),
  // What can be downloaded, and with what in it right now. The files
  // themselves are plain links the browser saves; nothing passes through here.
  exports:()=>getJSON('/api/library/exports'),
}});
const libraryApi=scopedLibraryApi(browserDisplay.api,()=>activeDomain);
const modelLibrary=new ModelLibrary({allowedKinds:['aircraft','person'],el:(...args)=>libraryPanel.el(...args),
  // The shelf can ask for the inventory itself, so a map that fails to start
  // no longer leaves the Library with nothing and no way to retry.
  load:()=>getJSON('/api/visual-assets')});
// Library forms and map controls share this browser's display preferences.
const providerRows={
  terrain:providerSetting({document,id:'terrain-provider',label:'지형 자료',description:'로컬 DEM은 보유 지역만 적용 (30m급 · EGM96 가정)',
    apply:value=>libraryPanel.setField('terrain','provider',value)}),
  imagery:providerSetting({document,id:'imagery-provider',label:'지도 영상',description:'지구 영상 공급자 — 브이월드 영상은 국내만 덮습니다',
    apply:value=>libraryPanel.setField('imagery','provider',value)}),
  buildings:providerSetting({document,id:'building-provider',label:'건물 자료',description:'3D 건물 공급자 — 브이월드 건물은 국내만 덮습니다',
    apply:value=>libraryPanel.setField('buildings','provider',value)}),
};
const buildingQualityRow=providerSetting({document,id:'building-quality',label:'건물 상세도',
  description:'상세도와 메모리 예산 — 표시 거리와 별개입니다',apply:value=>libraryPanel.setField('buildings','quality',value)});
const buildingDistanceRow=providerSetting({document,id:'building-distance',label:'건물 표시 거리',
  description:'화면이 향하는 지표의 최대 반경 — 도시·광역은 OSM/정밀 3D 권장',apply:value=>libraryPanel.setField('buildings','distance',value)});
// Dragged rather than picked: "a bit less than that" has no natural steps, and
// a list of four numbers somebody chose is not what the question is.
const percent=value=>`${Math.round(value*100)}%`;
const buildingOpacityRow=sliderSetting({document,id:'building-opacity',label:'건물 진하기',
  description:'낮추면 건물 뒤 지도가 더 비칩니다',min:.1,max:1,step:.05,fallback:.9,format:percent,
  apply:(value,{live})=>{
    // Preview while dragging; persist in this browser when the drag ends.
    liveGlobe?.setBuildingAppearance({...libraryPanel.values?.buildings,opacity:value});
    return live?true:libraryPanel.setField('buildings','opacity',value);
  }});
const buildingTintRow=providerSetting({document,id:'building-tint',label:'건물 색조',
  description:'높이별 음영 위에 곱해집니다 — 어느 건물이 높은지는 그대로 두고 도시의 색만 바꿉니다',
  apply:value=>libraryPanel.setField('buildings','tint',value)});
const buildingBrightnessRow=sliderSetting({document,id:'building-brightness',label:'건물 밝기',
  description:'너무 올리면 높은 건물부터 흰색으로 뭉개져 높이가 안 읽힙니다',
  min:.35,max:1.6,step:.05,fallback:1,format:percent,
  apply:(value,{live})=>{
    liveGlobe?.setBuildingAppearance({...libraryPanel.values?.buildings,brightness:value});
    return live?true:libraryPanel.setField('buildings','brightness',value);
  }});
const libraryPanel=createPanel(LibraryPanel,{api:libraryApi,models:modelLibrary,notify:(status,message)=>notify(`library:${message}`,status,message),
  // The settings rows offer what the server describes, at the stored value.
  onDescribed:(description,values)=>{
    uamPredictionControls.update(values?.uam_prediction);
    for(const [id,row] of Object.entries(providerRows)){
      const field=description.sources?.find(source=>source.id===id)?.fields?.find(field=>field.name==='provider');
      row.setChoices(field?.choices ?? [],values?.[id]?.provider ?? null);
    }
    const buildingFields=description.sources?.find(source=>source.id==='buildings')?.fields;
    buildingQualityRow.setChoices(buildingFields?.find(field=>field.name==='quality')?.choices??[],values?.buildings?.quality??'balanced');
    buildingDistanceRow.setChoices(buildingFields?.find(field=>field.name==='distance')?.choices??[],values?.buildings?.distance??'auto');
    buildingOpacityRow.setValue(values?.buildings?.opacity??.9);
    buildingBrightnessRow.setValue(values?.buildings?.brightness??1);
    buildingTintRow.setChoices(buildingFields?.find(field=>field.name==='tint')?.choices??[],
      values?.buildings?.tint??'neutral');
  },
  // A display source carries everything the map needs, not just a switch.
  onDisplay:(id,values)=>{
    // Settings and Live Twinning both offer clouds; keep their baselines in
    // agreement so a switch can undo a change made in the other panel.
    if(['terrain','buildings','imagery','clouds'].includes(id)){
      libraryPanel.values[id]={...values};livePanel.values[id]={...values};
    }
    const enabled=Boolean(values?.enabled);
    const button=$({terrain:'terrain',buildings:'buildings',clouds:'clouds'}[id]);
    if(button && button.getAttribute('aria-pressed')!==String(enabled))button.setAttribute('aria-pressed',String(enabled));
    if(id==='terrain'){liveGlobe?.setTerrainEnabled(enabled);void liveGlobe?.setTerrainSource(values?.provider);}
    else if(id==='buildings'){liveGlobe?.setBuildingsProvider(values?.provider);liveGlobe?.setBuildingAppearance(values);liveGlobe?.setBuildingsEnabled(enabled);}
    else if(id==='imagery')liveGlobe?.setImagerySource(values?.provider);
    // The twin does the estimating; the map only asks for a path when the
    // prediction is switched on. Whether the estimator behind it is on is the
    // server's business, and it answers with no path when it is not.
    else if(id==='trajectory_prediction')liveGlobe?.setTrajectoryPrediction(enabled);
    else if(id==='uam_prediction'){
      uamPredictionControls.update(values);
      for(const panel of [libraryPanel,livePanel]){
        panel.values[id]={...values};
        for(const [name,value] of Object.entries(values??{})){
          const field=panel.body?.querySelector('[name=uam_prediction__'+name+']');
          if(field){if(field.type==='checkbox')field.checked=Boolean(value);else field.value=String(value);}
        }
      }
      liveGlobe?.setUamPrediction(enabled,values);
    }
    else if(id==='risk_prediction')riskRadar?.setConfig(values);
    else if(id==='clouds'){
      liveGlobe?.setCloudSettings({enabled,source:values?.product,opacity:values?.opacity});
      cloudRefresh.every(values?.refresh_seconds);
    }
  }});
// A ten minute product goes stale on screen; the map re-reads it on its own cadence.
const cloudRefresh={timer:null,every(seconds){
  if(this.timer!==null)clearInterval(this.timer);
  this.timer=Number.isFinite(seconds)&&seconds>0?setInterval(()=>liveGlobe?.refreshClouds(),seconds*1000):null;
}};
// What each real-time twin model is holding at this instant, so the Live
// Twinning panel says what is actually in the twin rather than only what is
// configured. Filled from every snapshot; a model nothing counts yet answers
// nothing and its group simply says what it is waiting on.
const liveCounts={asset_states:null,traffic_airspace:null,environment:null,
  mission_resources:null,events_alerts:null};
// The Live Twinning panel is the same panel as the Library, pointed at the
// other section: the twin models on one side, what this workspace holds on the
// other. One implementation, so a feed moves between them by being grouped
// differently on the server rather than by being written twice.
// Which model does the estimating and which draws the prediction is chosen in
// a window that shows what each model is for, not from a list of names.
const aiModelLibrary=createPanel(AiModelLibrary,{document,mount:document.body,
  onPick:request=>{if(!livePanel.chooseModel(request))libraryPanel.chooseModel(request);}});
let liveAirspaceCount=null;
const livePanel=createPanel(LiveTwinningPanel,{domainOnly:'uam',api:libraryApi,counts:()=>liveCounts,aiLibrary:aiModelLibrary,
  onDescribed:(_description,values)=>uamPredictionControls.update(values?.uam_prediction),
  onFocusPhysical:id=>{liveGlobe?.select(id);liveGlobe?.focus(true);},
  context:()=>({vertiports:savedVertiportCount,airspace:liveAirspaceCount}),
  isVisible:()=>workPanel.openId==='live',
  notify:(status,message)=>notify(`live:${message}`,status,message),
  onDisplay:(id,values)=>libraryPanel.onDisplay(id,values)});
window.addEventListener('pagehide',()=>livePanel.destroy(),{once:true});
// Who the twin is for: by domain, and within UAM the pilot, the operator, the
// vertiport and the PSU. Each party's own view is mounted here as it is built.
const operationsSession=new OperationsSession();
const operationsFocus=new OperationsFocus({globe:()=>liveGlobe,readDeck:id=>operatingApi.get(id),
  notice:message=>notify('operations-focus','warning',message)});
const vertiportPanel=createPanel(VertiportPanel,{document,session:operationsSession,onFocusAircraft:id=>operationsFocus.aircraft(id),api:{list:operatingApi.list,weather:()=>getJSON('/api/live/weather'),
  // What the day being flown says this deck is doing. It is the server's own
  // answer, so every screen watching the same server sees the same occupancy.
  scenarioVertiport:operatingApi.vertiport},
  selectInView:records=>liveGlobe?.vertiportInView(records),onFocus:record=>liveGlobe?.flyToVertiport(record.layout.frame),
  onOpen:()=>{focusMode.set(false);}});
// The rules the day is flown by, drawn as the decisions they are with the
// numbers they turn on beside them. Each party opens it at its own chart from
// its own screen; the other three stay reachable as tabs, because they are one
// chain - a pad let go earlier is the same change seen from the deck and from
// the service, and separate windows would let them disagree.
const decisionPanel=createPanel(DecisionPanel,{document,api:{
  read:()=>getOperatingJSON('/api/operations/context/decisions'),
  write:values=>sendJSON('PUT','/api/decisions',{values}),
  reset:()=>sendJSON('POST','/api/decisions/reset',{})}});
// One deck, opened from the PSU's list of them: the saved ground layout
// coloured by the day being flown, and the landing queue in the order the
// service actually put it in. The layout comes from the same endpoint the
// vertiport screen reads, so both parties see the same deck.
const psuDeckView=createPanel(DeckDetail,{document,
  api:{vertiport:operatingApi.get,occupancy:operatingApi.vertiport},
  onFocus:row=>operationsFocus.aircraft(row.aircraft_id)});
const psuPanel=createPanel(PsuPanel,{document,session:operationsSession,deckView:psuDeckView,
  onDecisions:()=>void decisionPanel.open('psu'),
  onFocus:row=>operationsFocus.aircraft(row.aircraft_id),
  onFocusDeck:id=>void operationsFocus.deck(id),
  api:{scenarioVertiports:()=>getOperatingJSON('/api/operations/context/vertiports')},
  onOpen:()=>{focusMode.set(false);}});
// The vertiport screen shows what the replayed day is doing at the deck the
// operator has selected. That a day is being replayed at all is said by the
// replay console across the top of the map, not again in every panel.
const scenarioDeck=new ScenarioVertiportMonitor({api:operatingApi,document,
  selected:()=>vertiportPanel.selectedId ?? null,
  onFocus:row=>operationsFocus.aircraft(row?.aircraft_id)});
vertiportPanel.scenarioDeck=scenarioDeck;
const stakeholderPanel=createPanel(StakeholderPanel,{domainOnly:'uam',document,vertiportPanel,psuPanel,session:operationsSession,
  pilotPanel,onDecisions:role=>void decisionPanel.open(role)});
// A UAM of a replayed day carries a mission as well as a position: which phase
// it is in, which flight, and what the service has told it. The twin's entity
// says none of that, so it is asked for while the aircraft stays selected, and
// it keeps up because a phase changes while the panel is open.
// The card those two write into is built once the renderer is up, inside the
// boot block below. This binding lives out here with them: a `const` in that
// block is not in scope for a module-level function, so reaching for it threw
// and, being called from the render loop, stopped the map.
let selectionPanel=null,selectionWindows=null,aircraftCamera=null,cameraTarget=null;
let missionWatch=null,missionId=null,missionTrack=null,missionDetail=null;
let aircraftDashboard=null,detailDrawerOpen=false;
let missionRevision=0,missionPending=null;
function stopMission(){
  if(missionWatch)clearInterval(missionWatch);
  missionRevision++;missionPending=null;
  missionWatch=null;missionId=null;missionTrack=null;missionDetail=null;
}
// What is on the map for this aircraft, said in the panel so the two never
// disagree. The flown track is always drawn for a selected UAM; the predicted
// path is only there when the operator has that switch on.
function pathsText(){
  if(liveGlobe?.detailId && liveGlobe.detailId!==liveGlobe.selected)return '정보 조회 중 · 지도 추적 대상은 별도';
  const parts=[];
  if(missionTrack&&missionTrack.points>1)parts.push(`지나온 항적 ${missionTrack.points}점`);
  if(liveGlobe?.predictUam)parts.push('예상 경로');
  return parts.length?parts.join(' · '):'현재 위치만';
}
function paintMission(){
  if(!missionId||!missionDetail){selectionPanel.setMission(null);aircraftDashboard?.setMission(null);return;}
  selectionPanel.setMission({...missionDetail,paths:pathsText()});
  aircraftDashboard?.setMission(missionDetail);
}
async function readMission(){
  if(!missionId||missionPending===missionRevision)return;
  const id=missionId,revision=missionRevision;missionPending=revision;
  try{
    if(id.startsWith('physical:')){
      const detail=await getJSON(`/api/live/uam/${encodeURIComponent(id)}`);
      if(id===missionId&&revision===missionRevision){
        const timing=liveGlobe?.entityScene?.samples.physicalTiming?.(id);
        if(timing)detail.display_timing={...timing,age_s:Math.max(0,detail.server_time-timing.observation_time)};
        selectionPanel.setSensors(detail);
      }
      const mission=await operatingApi.aircraft(id);
      if(id===missionId&&revision===missionRevision){missionDetail=mission?.state?mission:null;paintMission();}
      return;
    }
    const detail=await scenarioApi.aircraft(id);
    if(id===missionId&&revision===missionRevision){missionDetail=detail;paintMission();}
  }catch{
    if(id===missionId&&revision===missionRevision){missionDetail=null;selectionPanel.setMission(null);}
  }finally{if(missionPending===revision)missionPending=null;}
}
function followMission(entity){
  const id=entity?.kind==='uam'?entity.entity_id:null;
  if(id===missionId)return;
  stopMission();
  selectionPanel.setSensors(null);
  selectionPanel.setMission(null);
  if(!id)return;
  missionId=id;
  void readMission();
  missionWatch=setInterval(()=>void readMission(),1500);
  missionWatch?.unref?.();
}
window.addEventListener('pagehide',stopMission,{once:true});
// Holding a role changes what this whole screen is answering as, so it is said
// beside the clock rather than only inside the panel that took the seat.
const roleBadge=new RoleBadge({node:$('role-badge'),session:operationsSession,document});
window.addEventListener('pagehide',()=>{vertiportPanel.destroy();psuPanel.destroy();pilotPanel.destroy();stakeholderPanel.destroy();roleBadge.destroy();operationsSession.destroy();},{once:true});
const readAnalysis=createAnalysisReader(getJSON);
operationsAnalysis=createPanel(OperationsAnalysis,{document,getJSON:readAnalysis,isSideVisible:()=>workPanel.openId==='analysis',
  onOpen:()=>{focusMode.set(false);},
  onAircraft:id=>{operationsAnalysis.close();operationsFocus.aircraft(id);}});
window.addEventListener('pagehide',()=>operationsAnalysis.destroy(),{once:true});
riskRadar=createPanel(RiskRadar,{document,getJSON,onSettings:openRiskSettings});
riskSelection=new RiskRadarSelection(riskRadar);
window.addEventListener('pagehide',()=>riskRadar.destroy(),{once:true});
const predictionPanel=createPanel(PredictionPanel,{document,getJSON,
  onRisk:id=>{openRiskRadar(id);},onRiskSettings:openRiskSettings,
  onOpen:()=>{focusMode.set(false);
    $('mode-prediction').setAttribute('aria-expanded','true');},
  onClose:()=>{$('mode-prediction').setAttribute('aria-expanded','false');$('mode-prediction').focus();},
  onSettings:()=>{const panel=workWindows.open('live').controller.panel;void panel.ready.then(()=>panel.openSettings('ai_models','uam_prediction'));}});
window.addEventListener('pagehide',()=>predictionPanel.destroy(),{once:true});
$('mode-prediction').onclick=()=>{if(activeDomain==='uam')predictionPanel.open();else if(activeDomain==='satellite')satelliteWorkspace.open('prediction');};

const SECTIONS={analysis:{label:'운항정보 분석',render:body=>operationsAnalysis.render(body)},
  live:{label:'Live Twinning',render:body=>livePanel.render(body)},
  simulation:{label:'Simulation',render:body=>simulationPanel.render(body)},
  library:{label:'Library',render:body=>libraryPanel.render(body)},
  stakeholders:{label:'Stakeholders',render:body=>stakeholderPanel.render(body)}};
// Leaving the Simulation section lets go of whatever its tab held on the map.
// Leaving Stakeholders stops the two watchers it started; nothing polls for a
// section that is not on screen.
const launchedWindows=installWindowLaunchers({document,workspace:windowWorkspace,focusMode,
 sources:{scenarioControl,predictionPanel,operationsAnalysis,pilotPanel,vertiportPanel,psuPanel,decisionPanel,psuDeckView,demandSummary,aiModelLibrary,riskRadar,
 libraryPanel,livePanel,simulationPanel,routePanel,planPanel,demandPanel,stakeholderPanel},
 onSimulationActive:(simulation,plan)=>{simulationPanel=simulation;if(plan.plan&&planPanel!==plan){planPanel=plan;liveGlobe?.showFlightPlan(plan.plan);}},
 onPlan:(owner,plan)=>{if(plan){planPanel=owner;liveGlobe?.showFlightPlan(plan);}else if(planPanel===owner){liveGlobe?.showFlightPlan(null);replayPresentation?.update(null);}},
 onFollow:(owner,sample,options)=>{if(planPanel!==owner)return;if(sample)liveGlobe?.followFlight(sample,options);else liveGlobe?.releaseFlight();},
 onSample:(plan,sample)=>{if(planPanel!==plan)return;liveGlobe?.moveFlight(sample);replayPresentation?.update({plan:plan.plan,run:plan.run,sample});}});
workWindows=launchedWindows.work;
for(const id of ['library','analysis','stakeholders','live','simulation'])$('mode-'+id).onclick=()=>{focusMode.set(false);if(activeDomain==='uam')workWindows.open(id);else if(activeDomain==='satellite')satelliteWorkspace.open(id);};
$('drawer-close').onclick=()=>workPanel.close();
window.addEventListener('pagehide',()=>launchedWindows.destroy(),{once:true});

document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  // The placement tools are what Escape closes first, then the pick itself;
  // the panel stays open through both. On the route tab its card, then its
  // adding mode, then the selection go first.
  if(workWindows?.escape())return;
  if(simulationPanel.escape())return;
  if(simulationPanel.toolsOpen){simulationPanel.resumeTools();return;}
  if(simulationPanel.picking){simulationPanel.cancelPick();return;}
  // Window closing is explicit through its own title bar.
});
// The display toggles are moved into the settings panel, so their existing
// wiring and state stay single-sourced; the camera rail keeps camera controls.
const displaySettings=$('display-settings');
for(const id of ['sunlight','buildings','terrain','place-names','airspace','clouds']) {
  const button=$(id),row=document.createElement('div');
  row.className='setting-row';if(['buildings','airspace'].includes(id))row.dataset.domainOnly='uam';
  const label=document.createElement('span');label.textContent=button.getAttribute('aria-label');
  row.append(label,button);displaySettings.append(row);
}
displaySettings.append(providerRows.terrain.row,providerRows.imagery.row,providerRows.buildings.row);
displaySettings.append(buildingDistanceRow.row,buildingQualityRow.row,buildingOpacityRow.row,
  buildingTintRow.row,buildingBrightnessRow.row);
// How large the map's own names are drawn. It applies to whatever map exists,
// including one created after the setting was read, because the layers keep the
// scale and every label they build later uses it.
let labelScale=1;
const mapLabelSetting=labelSizeSetting({document,apply:scale=>{labelScale=scale;liveGlobe?.setLabelScale(scale);}});
const displayQuality=displayQualitySetting({document,applyLabels:percent=>mapLabelSetting.recommend(percent)});
displaySettings.prepend(displayQuality.row);
const performanceControls=performanceSettings({document,profile:performanceProfile,limits:PERFORMANCE_LIMITS});
displaySettings.prepend(performanceControls.row);
for(const key of ['detailDistance','buildingFetches','hybridDistance','fog'])performanceControls.controls.get(key).row.dataset.domainOnly='uam';
mapLabelSetting.row.dataset.domainOnly='uam';
displaySettings.append(mapLabelSetting.row);
for(const row of [providerRows.buildings.row,buildingDistanceRow.row,buildingQualityRow.row,buildingOpacityRow.row,buildingTintRow.row,buildingBrightnessRow.row])row.dataset.domainOnly='uam';
const settingsPanel=$('settings-panel');
const showSettings=open=>{settingsPanel.hidden=!open;$('settings').setAttribute('aria-expanded',String(open));};
$('settings').onclick=()=>launchedWindows.openSettings(settingsPanel);
document.addEventListener('pointerdown',event=>{
  if(!settingsPanel.classList.contains('ww-managed') && !settingsPanel.hidden && !settingsPanel.contains(event.target) && !$('settings').contains(event.target))showSettings(false);
});
try {
  await loadCesium();report('library','지구 렌더러 준비 중');
  // The page shows the engine and provider credits once, in #map-credits. The
  // inspection widget renders a local model only, so its duplicate goes to a sink.
  selectionPanel=new SelectionPanel(globalThis.Cesium,{creditContainer:$('preview-credits'),
    isPrimaryModelPreparing:id=>{
      const item=liveGlobe?.items.get(id),layer=item&&liveGlobe.entityScene.layers[item.entity.kind];
      return Boolean(item&&!item.failed&&layer?.visible!==false&&layer?.showModels!==false
        &&liveGlobe.entityScene.assets.has(item.assetId)&&(item.loading||!item.model||item.model.ready===false));
    },
    isNavigating:()=>Boolean(document.hidden||liveGlobe?.entryActive||liveGlobe?.transitioning||liveGlobe?.approach||liveGlobe?.renderBudget?.moving)});
  // Read-only deck details share the operator panel's authoritative data.
  const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const destinationLoading=new DestinationLoading({document});
  const globe=new LiveGlobe(globalThis.Cesium,'globe',{reducedMotion,onHover:(entity,pointer,airspace)=>selectionPanel.hover(entity,pointer,airspace),
    // Clicking the planned aircraft says which flight it is and where it is in it.
    // Clicking the aircraft reads like clicking any other: the card opens, the
    // camera flies to it, and it stays followed until the panel lets go.
    onFlightPick:(flight,pointer,{detailsOnly=false}={})=>{replayPresentation?.pick();if(!detailsOnly&&!globe.cockpit?.active){globe.flyToFlight(flight?.sample);planPanel.setFollowing(true);}},
    onDestinationPreparation:state=>destinationLoading.update(state),
    creditContainer:$('map-credits'),onWarning:warning,onPlaceLabels:status=>{
    const labels={loading:'연결 중',ready:'표시 활성',off:'숨김',partial:'일부 타일 지연 — 토글로 재시도',error:'연결 실패 — 토글로 재시도'};
    $('place-status').textContent=`지역명 · ${labels[status] || status}`;
    $('place-names').title=`지역명 · ${labels[status] || status}`;
    if(status==='error' || status==='partial')notify('place-names',status,'지역명 수신 지연. 지역명 버튼을 껐다 켜면 다시 요청합니다.');
  },onTerrain:status=>{
    const labels={loading:'지형 연결 중',streaming:'현재 영역 정밀 지형 로딩',ready:liveGlobe?.activeTerrainSource==='local_dem'?'로컬 DEM 우선 · 범위 밖 Cesium':'World Terrain',error:'지형 연결 지연/실패',unavailable:'지형 인증 설정 필요'};
    $('terrain-status').textContent=`지형 · ${labels[status] || status}`;
    if(status==='error' || status==='unavailable')notify('terrain',status,labels[status]);
    else if(status==='ready' && notices.states.has('terrain'))notify('terrain','ready','지형 연결 복구');
  },onBuildings:(status,provider='osm')=>{
    const labels={off:'숨김',distant:'궤도·2D 시점에서는 숨김',terrain:'지형 준비 대기',ready:provider==='vworld_hybrid'?'혼합 건물 · 가까운 실사 + 먼 일반':provider==='vworld_3d'?'브이월드 정밀 3D 표시':provider==='vworld'?'브이월드 건물 표시':'OSM 건물 표시',loading:'연결 중',waiting:'연결 대기',outside:'국내에서만 표시',error:'연결 지연/실패 · 잠시 후 재시도',unavailable:provider.startsWith('vworld')?'브이월드 인증 설정 필요':'인증 설정 필요'};
    $('building-status').textContent=`3D 건물 · ${labels[status] || status}`;
    if(status==='error' || status==='unavailable')notify('buildings',status,`3D 건물 ${labels[status]}`);
    else if(status==='ready' && notices.states.has('buildings'))notify('buildings','ready','3D 건물 연결 복구');
  },onView:view=>viewReporter.report(view),onTerrainFlat:flat=>{
    $('terrain-status').textContent=flat?'지형 · 꺼짐 (평면 지표, 건물 숨김)':`지형 · ${liveGlobe?.activeTerrainSource==='local_dem'?'로컬 DEM 우선 · 범위 밖 Cesium':'World Terrain'}`;
    $('terrain').title=flat?'지형 기복(DEM) 켜기':'지형 기복(DEM) 표시 — 끄면 평면 지표, 건물도 함께 숨김';
  },onTrajectory:path=>{if(!replayPresentation?.selected)selectionPanel.setTrajectory(globe.detailId && globe.detailId!==globe.selected?null:path);},
  // The track layer answers later than the mission poll, so the line that says
  // what is on the map is repainted when it does.
  onFlightTrack:summary=>{missionTrack=summary;paintMission();},onMode:mode=>{
    const map=mode==='2d';
    $('scene-mode').setAttribute('aria-pressed',String(map));
    $('scene-mode').setAttribute('aria-label',map?'3D 지구 보기':'2D 지도 보기');
    for(const id of ['north','top'])$(id).disabled=map;
  },onSelect:(entity,{reopen=false,selected=false}={})=>{
    if(replayPresentation?.selected){if(!reopen&&!selected)return;replayPresentation.deselect();}
    // A click brings up the summary strip along the bottom. The inspection
    // drawer with every field opens from the strip's '상세', and stays open
    // across snapshots once it has been asked for; a deselect closes both.
    aircraftDashboard.show(entity);
    if(!entity||detailDrawerOpen)selectionPanel.show(entity);
    if(!entity)detailDrawerOpen=false;
    // A window of the card is asked for, never assumed: the strip's '창' and a
    // right-click open one; a plain click leaves the map to the strip.
    if(entity&&reopen)selectionWindows?.open(entity);riskSelection.map(entity,{reopen,selected});
    // The camera is opened by its own button, not by picking an aircraft. Once
    // it is open it follows the selection; a deselect closes it as before.
    cameraTarget=entity;$('camera-live').hidden=!AircraftCameraPanel.supports(entity);
    $('radar-live').hidden=!RADAR_KINDS.includes(entity?.kind);
    aircraftCamera?.select(entity,{selected:(reopen||selected)&&Boolean(aircraftCamera.isOpen)});
    if(reopen){
      // A right-click asks for everything: the drawer opens beside the strip.
      detailDrawerOpen=true;selectionPanel.show(entity);
      selectionPanel.setCollapsed(false);
      selectionPanel.setTrajectory(globe.detailId && globe.detailId!==globe.selected?null:globe.trajectory?.path??null);
    }
    $('track').setAttribute('aria-pressed',String(replayPresentation?.selected?planPanel.following:globe.detailsTracked()));
    followMission(entity);
  }});
  // The summary strip. Its buttons are the drawer's own buttons, pressed for
  // it, so both do exactly the same thing for the same aircraft.
  aircraftDashboard=new AircraftDashboard({document,supportsCamera:entity=>AircraftCameraPanel.supports(entity),
    cockpitReady:()=>!$('cockpit-view').disabled,following:()=>globe.detailsTracked(),
    actions:{
      expand:entity=>{detailDrawerOpen=true;selectionPanel.show(entity);selectionPanel.setCollapsed(false);
        selectionPanel.setTrajectory(globe.detailId && globe.detailId!==globe.selected?null:globe.trajectory?.path??null);paintMission();},
      window:entity=>selectionWindows?.open(entity),
      focus:()=>$('focus').click(),follow:()=>$('track').click(),cockpit:()=>$('cockpit-view').click(),
      // These two act on the aircraft the strip is showing rather than pressing
      // the drawer's buttons for it: the drawer's camera button works from its
      // own last selection, which a replayed flight never becomes.
      camera:entity=>{if(AircraftCameraPanel.supports(entity))aircraftCamera?.select(entity,{selected:true});},
      radar:entity=>openRiskRadar(entity?.entity_id),
      close:()=>{if(replayPresentation?.selected)replayPresentation.deselect();else globe.select(null);},
    }});
  window.addEventListener('pagehide',()=>aircraftDashboard.destroy(),{once:true});
  window.addEventListener('pagehide',()=>{selectionPanel.destroy();globe.destroy();},{once:true});
  liveGlobe=globe;
  aircraftCamera=new AircraftCameraPanel({document,workspace:windowWorkspace,globe,Camera:AirframeCamera,intruders,perception});
  window.addEventListener('pagehide',()=>aircraftCamera.destroy(),{once:true});
  globe.cockpit=new CockpitView({onViewChange:()=>manualFlight.panel.focusControls(),globe,Camera:CockpitCamera,Throttle:CockpitThrottle,Stick:CockpitStick,screenCorners,screenTransform,readMission:id=>id===missionId?missionDetail:null,readClock:id=>id?.startsWith('scenario:')?scenarioControl.status:null,readControls:()=>manualFlight.readControls(),readManual:()=>({sample:manualFlight.sample,plan:manualFlight.plan}),readPsu:()=>manualFlight.readPsu(),onPsu:kind=>manualFlight.requestPsu(kind),onControl:(action,value)=>manualFlight.control(action,value),onGround:action=>manualFlight.ground(action)});
  aircraftDashboard.setControls(globe.cockpit.panel.toolbar,{view:globe.cockpit.panel.viewControls,display:globe.cockpit.panel.displayControls,onMenuOpen:()=>globe.cockpit.panel.setDockExpanded(false)});
  globe.cockpit.panel.onDockOpen=()=>aircraftDashboard.closeMenus();
  $('selection').dataset.workspaceSource='true';
  selectionWindows=new SelectionWindows({document,singleton:true,C:globalThis.Cesium,template:$('selection'),workspace:windowWorkspace,
    onDismiss:id=>{
      if(globe.selected===id)globe.select(null);
      else if(globe.detailId===id){globe.detailId=null;globe.refreshDetails();}
      if(replayPresentation?.selected&&replayPresentation.entity?.entity_id===id)replayPresentation.deselect();
    },
    onFocus:id=>operationsFocus.aircraft(id),onFollow:id=>{globe.select(id);globe.focus(true);},
    onCockpit:id=>{if(replayPresentation?.entity?.entity_id===id)globe.cockpit.enterSingle();else{globe.select(id);$('cockpit-view').click();}},
    // The window's own camera button: the same camera, for the aircraft the
    // window is about. Its entity is the map's copy when it has one, and the
    // selection's otherwise (a replayed flight is not among the map's items).
    supportsCamera:entity=>AircraftCameraPanel.supports(entity),
    onRadar:id=>openRiskRadar(id),
    onCamera:id=>{const entity=globe.items?.get(id)?.entity??(cameraTarget?.entity_id===id?cameraTarget:null);if(AircraftCameraPanel.supports(entity))aircraftCamera?.select(entity,{selected:true});},
    getMission:async entity=>{const id=entity.entity_id;const mission=await operatingApi.aircraft(id);const sensors=id.startsWith('physical:')?await getJSON(`/api/live/uam/${encodeURIComponent(id)}`):null;return {mission,sensors};}});
  window.addEventListener('pagehide',()=>selectionWindows.destroy(),{once:true});
  replayPresentation=new ReplayPresentation({getJSON,
    postJSON:async(url,body,{signal})=>{
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(12000)])});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();
    },
    onDetails:(entity,state,{reopen=false}={})=>{
      aircraftCamera?.observeReplay(entity);
      // Replay pick/start is a selection, not a request for a detail window.
      if(reopen){
        detailDrawerOpen=false;selectionPanel.show(null);
        for(const view of [...(selectionWindows?.windows.values()??[])])view.close({notify:false});
        followMission(null);
      }
      aircraftDashboard?.show(entity);if(!entity||detailDrawerOpen)selectionPanel.show(entity);if(!entity)detailDrawerOpen=false;
      if(reopen&&aircraftCamera?.isOpen)aircraftCamera.select(entity,{reopen:true});
      if(entity&&state){
        selectionPanel.text('selected-source',state.sample.manual?'수동 비행 · FastPhysics':'단일 비행 기록 재생');
        selectionPanel.text('selected-mode',state.sample.mode??'');
        selectionPanel.text('model-disclaimer',`기록 재생 ${state.sample.time_s.toFixed(1)}초 / 배터리 ${(state.sample.battery_pct??0).toFixed(1)}% / 탑승 ${state.sample.passengers??0}명`);
        selectionPanel.setTrajectory(replayPresentation.prediction);
      }
    },
    onSnapshot:(snapshot,path)=>{predictionPanel.setReplay(snapshot,path);if(snapshot)selectionWindows?.observe(snapshot);},
    onPrediction:path=>{if(!replayTrajectory)return;if(path)void replayTrajectory.show(replayPresentation.entity);else replayTrajectory.clear();},
    onError:()=>notify('single-prediction','warning','단일 비행 예측을 받지 못했습니다. 서버 반영 여부와 AI 모델 상태를 확인해 주세요.')});
  replayTrajectory=new TrajectoryLayer(globe.C,globe.viewer,{
    load:()=>Promise.resolve(replayPresentation.prediction),supports:()=>Boolean(globe.predictUam),
    anchor:()=>{const e=replayPresentation.entity;return e?{time:e.state_time,position:e.position_ecef_m,epoch:replayPresentation.epoch,continuity_id:0,phase:e.flight_phase,clockRate:replayPresentation.state?.sample?.manual?1:planPanel.speed}:null;},
    onSummary:path=>{if(replayPresentation.selected)selectionPanel.setTrajectory(path);}});
  const removeReplayFrame=globe.viewer.scene.preRender.addEventListener(()=>replayTrajectory.follow());
  const replayPoll=setInterval(()=>{if(activeDomain!=='uam'||document.hidden)return;
    // Manual inference follows received native samples, never interpolated render time.
    if(!globe.flightLayer.sample?.manual)replayPresentation.update({plan:planPanel.plan,run:planPanel.run,sample:globe.flightLayer.sample});
    replayTrajectory.setComparisonVisibility(globe.uamPredictionSettings);
    void replayPresentation.refresh(globe.predictUam,globe.uamPredictionSettings);
  },500);
  window.addEventListener('pagehide',()=>{clearInterval(replayPoll);removeReplayFrame();replayPresentation.destroy();replayTrajectory.destroy();},{once:true});
  let entitySound=null;
  window.addEventListener('pagehide',()=>void entitySound?.destroy(),{once:true});
  globe.onVertiportPick=id=>{void vertiportPanel.showInfo(id);};globe.onVertiportPlaced=(id,info)=>simulationPanel.groundPlaced(id,info);
  // A deck that moved took its host building out from under one route and put
  // it under another: the building reports are about a city that has gone.
  globe.onClearedGround=()=>routePanel.dropConflicts();
  const applySun=enabled=>{
    globe.setSunEnabled(enabled);$('sunlight').setAttribute('aria-pressed',String(enabled));
    $('sunlight').title=enabled?'실시간 태양 조명 켜짐 — 클릭하면 전체 밝기':'실시간 태양 조명 꺼짐 — 지구 전체 은은한 밝기';
  };
  const applyPlaces=enabled=>{
    $('place-names').setAttribute('aria-pressed',String(enabled));void globe.setPlaceNamesEnabled(enabled);
  };
  applySun(browserDisplay.toggle('sunlight',false));
  applyPlaces(browserDisplay.toggle('place-names',true));
  displayQuality.attach(globe.displayResolution);
  performanceControls.attach(options=>globe.setPerformanceOptions(options));
  globe.setUamDisplay({...uamMenu.state,all:false});globe.setLabelScale(labelScale);
  for(const [kind,menu] of Object.entries(entityMenus))globe.setEntityDisplay(kind,{...menu.state,all:false});
  // The stored map choices reach the map before anyone opens the Library.
  // Domain-owned requests and sound are deferred until explicit selection.
  // Explicit opt-in handle for browser verification tools; available from map creation.
  if(new URLSearchParams(location.search).has('diagnostics')){
    globalThis.aerodtDiagnostics={globe,samples:globe.entityScene.samples,timing:globe.timing};
    // Explicit, read-only DOM evidence for initial model loading investigations.
    const readout=document.createElement('pre');readout.id='model-diagnostics';
    readout.style.cssText='position:fixed;bottom:50px;right:8px;z-index:99999;max-width:600px;max-height:230px;overflow:auto;background:#081520;color:#fff;font-size:10px';
    document.body.append(readout);
    const diagnosticTimer=setInterval(()=>{
      const s=globe.entityScene;
      readout.textContent=JSON.stringify({count:s.items.size,stats:s.stats,disowned:[...(s.disowned||[])],
        height:globe.viewer.camera.positionCartographic.height,
        layers:Object.fromEntries(Object.entries(s.layers).map(([k,v])=>[k,{visible:v.visible,models:v.models.show,labels:v.labels.show}])),
        items:[...s.items.values()].filter(i=>i.entity.kind==='uam').slice(0,5).map(i=>({id:i.entity.entity_id,lod:i.lod,failed:i.failed,loading:i.loading,model:!!i.model,ready:i.model?.ready,show:i.model?.show,attached:i.modelAttached,pixels:i.pixels,distance:i.distance,projection:i.projection}))},null,2);
    },1000);
    window.addEventListener('pagehide',()=>clearInterval(diagnosticTimer),{once:true});
  }
  globe.viewer.scene.renderError.addEventListener((_scene,error)=>{warning(`렌더링 중단: ${error.message}`);bootFinished=true;phases.fail('globe',error.message);loadingScreen.fail('지구 렌더링에 실패했습니다.',phases.percent);});
  loadingScreen.setStatus('지도 영상 공급자 연결 중');
  await globe.imagery();
  if(globe.imageryStatus==='ready')report('imagery','지형 데이터 준비 중');
  loadingScreen.setStatus('서버 상태 및 시각 자산 확인 중');
  let lastReceived=0,sourceKey='';
  function textIfChanged(element,value){if(element.textContent!==value)element.textContent=value;}
  const client=new WorkerTrackingClient({url:`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws/live`,
    onStatus:connectionStatus,
    onSnapshot:received=>{
      // Anything the operator has deliberately put in front of a camera joins
      // the snapshot here, before it fans out. The map, the camera's own scene
      // and the risk panel then see one object by the route every other
      // aircraft takes, rather than three descriptions of it.
      const snapshot=scopeSnapshot(activeDomain==='uam'?perception.inject(intruders.inject(received)):received,activeDomain);
      if(activeDomain==='uam'){predictionPanel.observe(snapshot);riskRadar.observe(snapshot);
        psuPanel.observe(snapshot);livePanel.observe(snapshot);workWindows?.observe(snapshot);}
      if(activeDomain==='satellite')satelliteWorkspace.observe(snapshot);
      selectionWindows?.observe(snapshot);
      lastReceived=Date.now();globe.replace(snapshot);
      if(transportStatus==='stale')connectionStatus('ready','상태 수신 복구');
      let satellites=0,aircraft=0,fixture=false;
      for(const e of snapshot.entities){if(e.kind==='satellite')satellites++;else if(e.kind==='aircraft')aircraft++;if(e.provenance==='fixture')fixture=true;}
      entityMenus.aircraft.setCount(`수신 항공기 ${aircraft.toLocaleString()}대`);
      entityMenus.satellite.setCount(`수신 위성 ${satellites.toLocaleString()}개`);
      $('data-mode').hidden=!fixture;
      if(fixture)notify('data-mode','fixture','TEST / NOT LIVE — 시험 데이터 표시');
      else if(notices.states.has('data-mode'))notify('data-mode','normal','시험 데이터 표시 해제');
      // The same numbers, told to the twin models that hold them.
      liveCounts.asset_states=`항공기 ${aircraft.toLocaleString()} · 위성 ${satellites.toLocaleString()}`
        +` · UAM ${livePanel.telemetry.counts.uam}`;
      if(activeDomain==='uam')livePanel.refreshCounts();
      $('snapshot-time').textContent='마지막 상태 · '+formatUtcClock(snapshot.state_time*1000);
      const nextSourceKey=JSON.stringify(snapshot.sources);
      if(sourceKey!==nextSourceKey){sourceKey=nextSourceKey;
        $('sources').replaceChildren(...snapshot.sources.map(source=>{
          const span=document.createElement('span');
          const statusText={ready:'수신 중',cached:'저장 데이터 사용',disabled:'외부 요청 꺼짐',error:'연결 실패',stale:'수신 지연'}[source.status] || source.status;
          span.textContent=`${source.id} · ${statusText}`;span.title=source.message || '';span.className=source.status==='ready'?'':'source-bad';
          notify(`source:${source.id}`,source.status,`${source.id} · ${statusText}`);return span;
        }));
      }
    }});
  window.addEventListener('pagehide',()=>client.stop(),{once:true});
  const results=await startupResources.data;
  if(startupController.signal.aborted)throw new Error('화면 준비가 취소되었습니다.');
  if(results[0].status==='fulfilled' && results[0].value.schema_version===1 && Array.isArray(results[0].value.assets)){
    globe.setAssets(results[0].value);selectionPanel.setAssets(results[0].value);
    // Cockpit profiles load only after UAM selection.
    libraryPanel.setModels({...results[0].value,assets:results[0].value.assets.filter(a=>a.kind!=='satellite')});
    satelliteWorkspace.setAssets(results[0].value);
    planPanel.setAssets(results[0].value);workWindows?.setAssets(results[0].value);selectionWindows?.setAssets(results[0].value);
    report('assets','시각 자산 목록 준비 완료');
  } else {phases.fail('assets','시각 자산 수신 실패');warning('3D 자산 목록 수신 실패. 지도와 위치 표시로 시작합니다.');
    // Say so on the shelf too, so the Library offers a retry instead of sitting
    // on "loading" for the rest of the session.
    libraryPanel.setModels(null);}
  if(results[1].status==='fulfilled' && validateSnapshot(results[1].value)){
    client.accept(results[1].value);report('snapshot','서버 상태 수신');
  } else {phases.fail('snapshot','초기 상태 수신 실패');warning('제한 모드: 초기 상태 수신 실패. 지구만 준비되었으며 연결을 다시 시도합니다.');}
  // The programs the first zoom, the first deck and the first hover would
  // otherwise compile in front of the operator are compiled here, behind the
  // loading screen and before the cadence sample that grades this display.
  loadingScreen.setStatus('지도 셰이더 준비 중');
  await globe.warmUpShaders();
  if(startupController.signal.aborted)throw new Error('화면 준비가 취소되었습니다.');
  loadingScreen.setStatus('화면 품질 최적화 중');
  await displayQuality.calibrate({signal:startupController.signal});
  if(startupController.signal.aborted)throw new Error('화면 준비가 취소되었습니다.');
  report('display','이 PC의 화면 해상도 맞춤 완료');
  // Calibration can resize the WebGL buffer. Verify the frame at that final
  // resolution, after all initial assets, before exposing any map pixels.
  await globe.waitForInitialView({signal:startupController.signal,onStatus:(message,state)=>{
    if(state.terrain==='ready')phases.complete('terrain');
    loadingScreen.setStatus(message);
  }});
  report('globe','지구 시작 화면 준비 완료');
  bootFinished=true;
  const entryLocks=new Map();
  globe.onEntry=active=>{
    if(active){for(const element of document.body.children){
      if(['loading','attribution','welcome'].includes(element.id))continue;
      entryLocks.set(element,element.inert);element.inert=true;
    }}else{for(const [element,inert] of entryLocks)element.inert=inert;entryLocks.clear();}
  };
  const domainReveal=$('domain-reveal');let domainRevealTimer=null;
  const coverDomain=()=>{clearTimeout(domainRevealTimer);domainRevealTimer=null;domainReveal.hidden=false;domainReveal.dataset.phase='covered';};
  const hideDomainReveal=()=>{clearTimeout(domainRevealTimer);domainRevealTimer=null;domainReveal.dataset.phase='idle';domainReveal.hidden=true;};
  const revealDomain=()=>{
    if(reducedMotion){hideDomainReveal();return;}
    requestAnimationFrame(()=>{domainReveal.dataset.phase='revealing';
      domainRevealTimer=setTimeout(hideDomainReveal,1050);});
  };
  window.addEventListener('pagehide',()=>clearTimeout(domainRevealTimer),{once:true});
  let uamEntry=null;
  window.addEventListener('pagehide',()=>uamEntry?.reveal(),{once:true});
  const activateDomain=async id=>{
    coverDomain();
    activeDomain=id;document.body.dataset.domain=id;
    const uam=id==='uam',profile=DOMAINS[id];
    $('reset').setAttribute('aria-label',uam?'서울 기본 시야':'지구 전체 시야');
    $('reset').title=uam?'서울 기본 시야':'지구 전체 시야';
    for(const node of document.querySelectorAll('[data-domain-only]'))node.hidden=node.dataset.domainOnly!==id;
    for(const kind of ['live','simulation','library','stakeholders','prediction','analysis']){
      const button=$('mode-'+kind),label=button.querySelector('span');
      if(!button.dataset.baseLabel)button.dataset.baseLabel=label?.textContent??kind;
      if(label)label.textContent=`${profile.label} ${button.dataset.baseLabel}`;
      button.title=`${profile.label} / ${button.dataset.baseLabel}`;
      button.setAttribute('aria-label',button.title);
    }
    $('domain-badge').hidden=false;$('domain-badge').textContent=`${profile.label} ▾ 도메인 변경`;
    $('settings-panel').setAttribute('aria-label',`${profile.label} / 공용 지도 설정${uam?' 및 UAM 사운드':''}`);
    const heading=$('settings-panel').querySelector('h2,h3,strong');if(heading)heading.textContent=`${profile.label} / 설정`;
    globe.setUamDisplay({...uamMenu.state,all:uam&&uamMenu.state.all!==false});
    globe.setScenarioPassengers(uam&&uamMenu.state.all!==false);
    for(const [kind,menu] of Object.entries(entityMenus))globe.setEntityDisplay(kind,{...menu.state,all:profile.kinds.includes(kind)&&menu.state.all!==false});
    watchWhileVisible();
    await libraryPanel.sync();
    if(uam){
      if(results[0].status==='fulfilled')void loadCockpitProfiles(results[0].value,url=>getJSON(url,{signal:startupController.signal}));
      entitySound??=new EntitySoundControls({audio:new SelectedEntityAudio(),readSample:()=>sceneSoundSample(globe)});
      void livePanel.sync();void simulationPanel.refresh().then(()=>routePanel.refresh());
      try{if(localStorage.getItem('aerodt.airspace')==='1')void airspace.on();}catch{}
      uamEntry=prepareDomainEntry(beforeReveal=>globe.entry({reducedMotion,prepare:true,beforeReveal}));
      void uamEntry.flight.catch(error=>notify('domain-entry','error',`서울 진입 실패: ${error.message}`));
      await uamEntry.ready;
    }else{
      globe.setAirspaceEnabled(false);globe.setBuildingsEnabled(false);
      globe.setTrajectoryPrediction(false);globe.setUamPrediction(false);
      earthView(globe);
    }
  };
  const domainChooser=new DomainChooser({root:$('welcome'),onSelect:activateDomain,onAfterClose:id=>{
    // GPU compilation happens behind the chooser; only the prepared flight is shown.
    if(id==='uam'){
      hideDomainReveal();
      uamEntry?.reveal();
    }else revealDomain();
  },
    onFailure:hideDomainReveal,reducedMotion});
  window.addEventListener('pagehide',()=>domainChooser.destroy(),{once:true});
  $('domain-badge').onclick=()=>{
    if(window.confirm('도메인을 변경하면 현재 브라우저의 조종 연결과 열린 창이 종료됩니다. 서버의 공유 시뮬레이션은 초기화하지 않습니다. 선택 화면으로 돌아갈까요?'))location.reload();
  };
  loadingScreen.finish(phases.percent,phases.ready?'지구와 서버 상태 준비 완료':'지구 준비 완료 / 일부 연결 실패 — 제한 모드로 시작',
    {reducedMotion,onLeave:()=>domainChooser.show()});
  client.start();
  $('sunlight').onclick=()=>{
    const enabled=$('sunlight').getAttribute('aria-pressed')!=='true';
    applySun(enabled);browserDisplay.setToggle('sunlight',enabled);
  };
  $('buildings').onclick=()=>{
    const enabled=$('buildings').getAttribute('aria-pressed')!=='true';
    void libraryPanel.setField('buildings','enabled',enabled);
  };
  $('terrain').onclick=()=>{
    const enabled=$('terrain').getAttribute('aria-pressed')!=='true';
    void libraryPanel.setField('terrain','enabled',enabled);
  };
  $('place-names').onclick=()=>{
    const enabled=$('place-names').getAttribute('aria-pressed')!=='true';
    applyPlaces(enabled);browserDisplay.setToggle('place-names',enabled);
  };
  // Airspace: prohibited, restricted and danger areas and the rest, drawn on
  // the ground with the pointer naming each. The collection is asked for on
  // the first switch-on and kept; the choice is remembered in this browser.
  const airspace={loaded:false,async on(){
    globe.setAirspaceEnabled(true);
    if(this.loaded)return;
    try {
      const body=await getJSON('/api/airspace');
      const state=body.status?.state;
      if(state==='unconfigured'){notify('airspace','unavailable','공역: 인증 설정 필요 (datago.json 또는 vworld.json)');return;}
      if(state==='error'){notify('airspace','error',`공역: ${body.status.detail}`);return;}
      const count=globe.showAirspace(body.collection);this.loaded=count>0;
      // The 교통·공역 model holds the airspace, so it says how much of it it has.
      liveAirspaceCount=count;liveCounts.traffic_airspace=count?`공역 ${count}개 구역`:null;if(activeDomain==='uam')livePanel.refreshCounts();
      const problems=body.status?.problems?.length?` · ${body.status.problems.length}개 레이어 실패`:'';
      notify('airspace',count?'ready':'error',count?`공역 ${count}개 구역 표시${problems}`:`공역: 받은 구역이 없습니다${problems}`);
    } catch {notify('airspace','error','공역 자료를 받지 못했습니다.');}
  }};
  $('airspace').onclick=()=>{
    const enabled=$('airspace').getAttribute('aria-pressed')!=='true';
    $('airspace').setAttribute('aria-pressed',String(enabled));
    try {localStorage.setItem('aerodt.airspace',enabled?'1':'0');} catch {}
    if(enabled)void airspace.on(); else globe.setAirspaceEnabled(false);
  };
  let airspaceRemembered=false;
  try {airspaceRemembered=localStorage.getItem('aerodt.airspace')==='1';} catch {}
  if(activeDomain==='uam'&&airspaceRemembered)$('airspace').onclick();
  // Clouds: the same browser-local switch as in the Live Twinning form.
  $('clouds').onclick=()=>{
    const enabled=$('clouds').getAttribute('aria-pressed')!=='true';
    void livePanel.setField('clouds','enabled',enabled);
  };
  $('zoom-in').onclick=()=>globe.zoom(.65);$('zoom-out').onclick=()=>globe.zoom(1.5);
  $('zoom').oninput=event=>globe.setRange(20*Math.exp(Number(event.target.value)/100*Math.log(60000000/20)));
  $('north').onclick=()=>globe.orient();$('top').onclick=()=>globe.orient(true);$('reset').onclick=()=>{if(activeDomain==='satellite')earthView(globe);else globe.reset();$('track').setAttribute('aria-pressed','false');};
  // Looking at the target from outside means leaving the cockpit first. Without
  // that the cockpit kept setting the camera every frame and the flight had
  // nowhere to go; when it did let go it put the camera back where the pilot had
  // been standing, so the view went to the vertiport before coming to the
  // aircraft. Leaving on purpose keeps the pose, so the camera starts at the
  // aircraft and pulls out from there.
  $('focus').onclick=()=>{
    const leaving=Boolean(globe.cockpit?.active);
    if(leaving)globe.cockpit.exit(false,true);
    return replayPresentation?.selected?globe.flyToFlight(globe.flightLayer.sample):globe.focusDetail(false,{departure:leaving});
  };
  // The aircraft camera, on request: the same window a pick used to open on its
  // own, now opened for the selected aircraft when the operator asks for it.
  $('camera-live').onclick=()=>{if(AircraftCameraPanel.supports(cameraTarget))aircraftCamera?.select(cameraTarget,{selected:true});};
  $('radar-live').onclick=()=>openRiskRadar(cameraTarget?.entity_id);
  // Closing the card puts the reading away, not the target: what is being
  // followed stays followed, and the chip by the layer buttons brings it back.
  $('clear').onclick=()=>{detailDrawerOpen=false;selectionPanel.show(null);};
  $('selection-restore').onclick=()=>selectionPanel.setCollapsed(false);
  $('scene-mode').onclick=()=>{
    const map=globe.sceneMode!=='2d';
    $('scene-mode').setAttribute('aria-pressed',String(map));
    void globe.setSceneMode(map?'2d':'3d');
  };
  const escape=event=>{if(event.key!=='Escape' || globe.entryActive)return;
    if(globe.cockpit?.active){globe.cockpit.exit(true);return;}
    if(!$('settings-panel').hidden)showSettings(false);else globe.select(null);};
  document.addEventListener('keydown',escape);
  $('track').onclick=()=>{
    if(replayPresentation?.selected){if(globe.cockpit?.active){globe.cockpit.exit(true);planPanel.setFollowing(true);}else planPanel.setFollowing(!planPanel.following);manualFlight.panel.focusControls();$('track').setAttribute('aria-pressed',String(planPanel.following));return;}
    // From a seat inside, 외부 추적 is the way out rather than a toggle: you
    // cannot already be following the aircraft you are sitting in. Leaving on
    // purpose keeps the pose, and `exit(true)` frames the same aircraft from
    // outside, so the camera pulls back from it instead of arriving at it.
    if(globe.cockpit?.active){globe.cockpit.exit(true);$('track').setAttribute('aria-pressed','true');return;}
    const centre=!globe.detailsTracked();
    if(centre)globe.focusDetail(true);else globe.stopTracking();
    $('track').setAttribute('aria-pressed',String(centre));
  };
  const interval=setInterval(()=>{
    const summary=globe.performanceSummary();
    performanceControls.report(activeDomain==='satellite'?{...summary,environment:null}:summary);
    if(document.activeElement!==$('zoom'))$('zoom').value=100*Math.log(globe.range()/20)/Math.log(60000000/20);
    if(lastReceived && Date.now()-lastReceived>5000 && transportStatus==='ready')connectionStatus('stale','새 상태 수신 지연 · 마지막 위치 유지');
    $('track').setAttribute('aria-pressed',String(replayPresentation?.selected?planPanel.following:globe.detailsTracked()));
  },500);
  window.addEventListener('resize',()=>globe.viewer.resize());
  // Explicit opt-in handle for browser verification tools; not used by the UI.
  if(globalThis.aerodtDiagnostics)Object.assign(globalThis.aerodtDiagnostics,{client,changeWatch});
  const pauseTransport=()=>client.setPaused(document.hidden);
  document.addEventListener('visibilitychange',pauseTransport);pauseTransport();
  window.addEventListener('pagehide',()=>{clearInterval(interval);document.removeEventListener('visibilitychange',pauseTransport);document.removeEventListener('keydown',escape);},{once:true});
} catch(error) {
  bootFinished=true;phases.fail('globe',error.message);loadingScreen.fail(error.message,phases.percent);
}
