import {CameraSpringArm} from './camera_spring_arm.js';
import {DestinationPreparation} from './destination_preparation.js';
import {waitForInitialView} from './initial_view.js';
import {CameraRangeMotion,cameraEase} from './camera_motion.js';
import {KeyboardNavigation} from './keyboard_navigation.js';
import {localOffset,offsetFromHeadingPitchRange,approachOffset,departureOffset,approachDuration,approachPose,approachView} from './approach_path.js?v=20260921-camera-departure';
import {mapOffset,mapWidthForRange,morphPromise,lockMapControls} from './scene_mode.js';
import {EntityScene} from './entity_scene.js?v=20260921-manual-ground';
import {TrajectoryLayer} from './trajectory_layer.js';
import {FlightTrackLayer} from './flight_track_layer.js';
import {cabinAt,showCabin,showDoors} from './cabin_passengers.js?v=20260917-cabin-passengers';
import {ScenarioPassengerLayer} from './scenario_passengers.js?v=20260917-cabin-passengers';
import {VertiportLayer, footprintsOf, overlapsFootprint, texturedAppearance} from './vertiport_layer.js?v=20260921-inset-lights';
import {retainShaderPrograms} from './shader_retention.js';
import {budgetTileProcessing} from './tile_processing_budget.js';
import {warmUpShaders, warmUpImage} from './shader_warmup.js';
import {flightShaderModels} from './visual_asset_loader.js';
import {RouteLayer,distanceMetres} from './route_layer.js';
import {PairLayer} from './pair_layer.js';
import {AirspaceLayer,PICK_SLACK_PX,airspaceBoundaryOf,pickThroughAirspace} from './airspace_layer.js';
import {pickNearbyUam} from './uam_picking.js';
import {FlightLayer} from './flight_layer.js?v=20260917-cabin-passengers';
import {drawBranded,loadMark,recordingBitrate,shownMark} from './capture_brand.js';
// Frames a second a recording asks the canvas for. Thirty reads as motion
// without doubling what the encoder and the copy each frame have to do.
const RECORDING_FPS=30;
// How close the camera settles to a followed aircraft: near enough to read the
// airframe and its rotors. It is where an approach ends and where the arm
// starts, not a limit — the operator moves in and out from there freely.
const FLIGHT_VIEW_RANGE_M=180;
import {ENTRY,planEntry} from './entry_flight.js';
import {CockpitEnvironment} from './cockpit_environment.js?v=20260917-realism';
import {CloudLayer} from './cloud_layer.js';

// Where a session begins and where "처음 위치" returns to.
const HOME_VIEW={longitude:126.978,latitude:37.5665,height:120000}; // Seoul city-wide view
// How soon a moved pointer is picked, and how often a still one is re-asked.
const HOVER_PICK_MS=80;
const HOVER_RECHECK_MS=400;
// How long the head switch takes to reach full speed, and how long it takes to
// stop. Starting is the keyboard camera's own constant, so the two controls
// feel like one. Stopping is deliberately quicker: an ease-out reads as the
// camera settling, but carried past about a fifth of a second it stops reading
// as smoothness and starts reading as the view drifting after you let go --
// measured at the first pair of these, five degrees over half a second.
const LOOK_RAMP_S=.09;
const LOOK_RELEASE_S=.05;
import {loadImageryProvider,retryTile} from './visual_asset_loader.js';
import {FrameTiming} from './frame_timing.js';
import {CameraRenderBudget,cockpitBudgetPose} from './render_budget.js?v=20260921-turn-budget';
import {performanceProfile,layerBudgets} from './performance_profile.js';
import {DisplayResolution} from './display_resolution.js';
import {BuildingLayer, loadOsmBuildings} from './building_layer.js';
import {VWorldBuildingLayer, footprintAppearance} from './vworld_building_layer.js?v=20260913-focus-budget';
import {HybridBuildingCoordinator} from './hybrid_buildings.js';
import {appearanceOf} from './building_appearance.js';
import {BuildingTileFocus,BuildingViewCache,loadVWorldBuildings,BUILDING_NEAR_HEIGHT,BUILDING_FAR_HEIGHT,buildingRange} from './building_streaming.js?v=20260913-focus-budget';
import {CameraEnvironment} from './camera_environment.js?v=20260913-focus-budget';
import {VWorldImagery,BASE_SOURCE} from './vworld_imagery.js';
import {TerrainLayer,loadWorldTerrain,configureTerrainStreaming,configureRequestBudget,motionScreenSpaceError,TERRAIN_SCREEN_SPACE_ERROR} from './terrain_layer.js';
import {TerrainDetail} from './terrain_detail.js';
import {loadLocalTerrain} from './local_terrain_provider.js';
import {PlaceLabels} from './place_labels.js';
import {InfrastructureLabelFade} from './infrastructure_label_fade.js';
import {RouteGeometryFade} from './route_geometry_fade.js';
import {ARRIVAL_FADE_MS,LABEL_FADE_MS} from './label_fade.js';
import {pickGround,clearanceHeight,SurfaceReadiness} from './camera_surface.js';
import {applySceneStyle, applyImageryStyle, setSunLighting, createStarSkyBox, buildingStyle} from './globe_style.js';

// Where a scheduled UAM has already been, served by the day that is flying it.
// Who is walking to or from an aircraft on a deck right now, across the day.
async function defaultScenarioPassengers() {
  let response=await fetch('/api/operations/context/passengers',
    {signal:AbortSignal.timeout(8000),cache:'no-store'});
  if(response.status===404)response=await fetch('/api/simulation/scenario/passengers',
    {signal:AbortSignal.timeout(8000),cache:'no-store'});
  if(!response.ok)return null;
  return response.json();
}

async function defaultFlightTrack(entityId) {
  const path=entityId.startsWith('physical:')?`/api/live/uam/${encodeURIComponent(entityId)}/track`
    :`/api/simulation/scenario/aircraft/${encodeURIComponent(entityId)}/track`;
  const response=await fetch(path,
    {signal:AbortSignal.timeout(8000),cache:'no-store'});
  if(!response.ok)return null;
  const track=await response.json();
  return Array.isArray(track?.points)?track:null;
}

// Read-only projection served by Communication for the selected object only.
export async function defaultTrajectory(entityId) {
  const response=await fetch(`/api/live/trajectory/${encodeURIComponent(entityId)}`,
    {signal:AbortSignal.timeout(8000),cache:'no-store'});
  if(!response.ok)return null;
  const path=await response.json();
  return path?.schema_version===1 || (path?.schema_version===2 && path?.kind==='uam_prediction_comparison')?path:null;
}

export class LiveGlobe {
  constructor(C, container, {onSelect = () => {}, onHover = () => {}, onFlightPick = () => {}, onWarning = () => {}, onDestinationPreparation = () => {}, onBuildings = () => {}, onTerrain = () => {}, onPlaceLabels = () => {}, onTrajectory = () => {}, onFlightTrack = () => {}, onMode = () => {}, onTerrainFlat = () => {}, onView = () => {}, loadTrajectory = defaultTrajectory, loadFlightTrack = defaultFlightTrack, loadScenarioPassengers = defaultScenarioPassengers, creditContainer,terrainEnabled=true,reducedMotion=false} = {}) {
    this.C = C; this.onSelect = onSelect; this.onHover=onHover;this.onFlightPick=onFlightPick;this.onWarning = onWarning;
    this.selected = null;
    configureRequestBudget(C.RequestScheduler);
    this.timing = new FrameTiming();
    this.renderBudget=new CameraRenderBudget();this.buildingViewCache=new BuildingViewCache(C);
    this.cameraEnvironment=new CameraEnvironment();
    // A spare copy of the mark, in case a capture is taken before the page's
    // own has loaded or from a page that does not show one.
    this.mark=null;this.recorder=null;
    void loadMark(globalThis.document).then(mark=>{this.mark ??= mark;});
    // Entity visualizers read properties on clock.tick, BEFORE scene.preRender.
    // Register first so even a newly arrived entity is faded before that read.
    const clock=new C.Clock({clockStep:C.ClockStep.SYSTEM_CLOCK,shouldAnimate:true});
    this.removeAnnotationTick=clock.onTick.addEventListener(()=>{
      if(this.viewer && !globalThis.document?.hidden)this.paintInfrastructureFade(performance.now());
    });
    this.annotationClock=new C.ClockViewModel(clock);
    // Preserve Cesium ion and provider credits when streamed buildings are used.
    this.viewer = new C.Viewer(container, {baseLayer: false, baseLayerPicker:false, geocoder:false,
      homeButton:false, sceneModePicker:false, navigationHelpButton:false, animation:false, timeline:false,
      fullscreenButton:false, infoBox:false, selectionIndicator:false, shouldAnimate:true,creditContainer,clockViewModel:this.annotationClock});
    const v = this.viewer;
    // A compiled program stays compiled: a city cell, a deck material or a
    // pick variant that comes back after its last user went is a cache hit,
    // not a 50-1000 ms Direct3D link wait in the middle of a zoom or an edit.
    this.shaderRetention=retainShaderPrograms(v.scene);
    // A batch of city tiles is finished one per frame rather than all in the
    // frame it landed: finishing a tile is its GPU upload, its draw commands
    // and its per-feature style, and Cesium OSM Buildings hands over several
    // at once as the camera crosses a city.
    this.tileBudget=budgetTileProcessing(C);
    this.placeLabels=new PlaceLabels({
      isReady:()=>v.scene.globe.tilesLoaded,
      stableMs:250,
      suspended:true, // Keep geographic names hidden until the opening flight settles.
      load:async()=>{
        const {provider}=await loadImageryProvider(
          ()=>C.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer'),
          ()=>Promise.reject(new Error('Place names unavailable')));
        return provider;
      },attach:provider=>{
        // Regional names only. Below terrain level 14 this layer would double
        // the imagery requests to the same host for street-level text that is
        // unreadable at that size, and those requests compete with the tiles.
        const layer=new C.ImageryLayer(provider,{maximumTerrainLevel:14});v.imageryLayers.add(layer);return layer;
      },detach:layer=>v.imageryLayers.remove(layer,true),onStatus:onPlaceLabels});
    // No frame-rate gate: Cesium's loop skips a rAF frame whose interval lands
    // at or under the gate, which on a 60 Hz display is every other frame.
    // A lower cadence the operator chooses is applied in setPerformanceOptions.
    v.targetFrameRate=undefined;
    v.resolutionScale=1;
    this.displayResolution=new DisplayResolution(v);
    v.scene.skyBox.destroy();
    v.scene.skyBox=createStarSkyBox(C);
    applySceneStyle(C, v.scene);
    this.cockpitEnvironment=new CockpitEnvironment(C,v.scene);
    v.clock.clockStep=C.ClockStep.SYSTEM_CLOCK;
    // One building provider shown at a time; only the shown one reports.
    this.buildingProvider='osm';this.buildingsEnabled=true;
    this.buildingAppearance={quality:'balanced',opacity:.9,distance:'auto',tint:'neutral',brightness:1};
    this.buildings=new BuildingLayer({load:()=>loadOsmBuildings(C),nearMetres:BUILDING_NEAR_HEIGHT,farMetres:BUILDING_FAR_HEIGHT,
      attach:tiles=>{
        tiles.style=buildingStyle(C,appearanceOf(this.buildingAppearance));
        this.osmTiles=tiles;
        // HIGHLIGHT multiplies OSM's baked olive colour by the grey style.
        // Replace it rather than producing dark green silhouettes.
        tiles.colorBlendMode=C.Cesium3DTileColorBlendMode?.REPLACE;
        this.osmBuildingFocus=new BuildingTileFocus(C,tiles);
        this.osmBuildingFocus.setAppearance(this.buildingAppearance);this.osmBuildingFocus.update(v.camera);
        v.scene.primitives.add(tiles);
        tiles.tileFailed.addEventListener(()=>{if(this.buildingProvider==='osm')onBuildings('error','osm');});
      },onStatus:status=>{if(this.buildingProvider==='osm')onBuildings(status,'osm');}});
    this.vworldBuildings=new VWorldBuildingLayer({C,scene:v.scene,groundHeights:points=>this.groundHeights(points),
      onStatus:status=>{if(['vworld','vworld_hybrid'].includes(this.buildingProvider))onBuildings(status,this.buildingProvider);}});
    this.vworld3d=new BuildingLayer({load:()=>loadVWorldBuildings(C),nearMetres:BUILDING_NEAR_HEIGHT,farMetres:BUILDING_FAR_HEIGHT,
      attach:tiles=>{
        this.vworld3dFocus=new BuildingTileFocus(C,tiles,{textured:true});
        this.hybridBuildings?.attach(this.vworld3dFocus);
        this.vworld3dFocus.setAppearance(this.buildingAppearance);
        this.vworld3dFocus.update(v.camera,{view:this.hybridBuildings?.view??null,targetFps:this.performanceOptions?.targetFps??60});
        v.scene.primitives.add(tiles);
        tiles.tileFailed.addEventListener(()=>{if(this.buildingProvider==='vworld_3d')onBuildings('error','vworld_3d');});
      },onStatus:status=>{if(this.buildingProvider==='vworld_3d')onBuildings(status,'vworld_3d');}});
    this.vworld3d.setEnabled(false);
    this.hybridBuildings=new HybridBuildingCoordinator({C,scene:v.scene,footprints:this.vworldBuildings});
    // National imagery over Korea, above the world imagery once that is there.
    this.vworldImagery=new VWorldImagery(C,v,{style:layer=>applyImageryStyle(layer,v.scene.globe.enableLighting)});
    configureTerrainStreaming(v.scene.globe);
    // Uniform detail over peak detail: the queue length drives the allowed error.
    this.detail=new TerrainDetail({base:TERRAIN_SCREEN_SPACE_ERROR});this.pendingTiles=0;this.approachDetail=0;this.lastDetail=0;
    v.scene.globe.tileLoadProgressEvent.addEventListener(pending=>{this.pendingTiles=pending;});
    this.surface=new SurfaceReadiness();
    this.terrainSource='world_terrain';this.activeTerrainSource='world_terrain';this.terrainRevision=0;this.onTerrainStatus=onTerrain;
    this.terrain=terrainEnabled ? new TerrainLayer({load:options=>loadWorldTerrain(C,options),
      attach:provider=>{this.worldTerrain=provider;this.attachTerrain(provider);void this.setTerrainSource(this.terrainSource);},onStatus:onTerrain}) : null;
    this.buildings.setSurfaceReady(false);this.vworldBuildings.setSurfaceReady(false);
    this.terrainFlat=false;this.savedTerrainProvider=null;this.onTerrainFlat=onTerrainFlat;
    this.terrain?.start();
    v.scene.globe.depthTestAgainstTerrain = true;
    v.scene.screenSpaceCameraController.minimumZoomDistance = 20;
    v.scene.screenSpaceCameraController.maximumZoomDistance = 60000000;
    v.scene.screenSpaceCameraController.enableZoom = false;
    // A lost context cannot be recovered by Cesium; models stop drawing while
    // labels go on, which reads as aircraft vanishing. Name it, so the operator
    // reloads instead of hunting for a setting.
    v.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault?.();this.contextLost=true;
      this.onWarning('3D 지도 그래픽 컨텍스트가 손실되었습니다 · 페이지를 새로고침하세요 (다른 3D 창이 너무 많이 열렸다 닫힌 경우)');});
    this.entityScene=new EntityScene(C,v,onWarning);this.items=this.entityScene.items;
    this.destinationPreparation=new DestinationPreparation(this.entityScene,{onStatus:onDestinationPreparation});
    // Display of a path the Live Twin computed; this layer never propagates.
    // An aircraft has a path only while the operator has the twin's prediction
    // switched on: without it the server serves none and none is asked for.
    this.predictAircraft=false;this.predictUam=false;
    this.trajectory=new TrajectoryLayer(C,v,{load:loadTrajectory,onSummary:onTrajectory,onWarning,
      supports:entity=>entity?.kind==='satellite'
        || (this.predictAircraft && entity?.kind==='aircraft')
        || (this.predictUam && entity?.kind==='uam'),
      // Where the object is drawn at this instant, in the twin's own clock, so
      // a predicted path starts on the aircraft and slides along with it.
      anchor:id=>this.displayAnchor(id)});
    // Where the selected UAM has already been. Its own layer because it answers
    // a different question from the prediction and must not replace it: an
    // operator wants the flown path and the projected one on screen together.
    this.flightTrack=new FlightTrackLayer(C,v,{load:loadFlightTrack,onSummary:onFlightTrack,
      supports:entity=>entity?.kind==='uam',
      // Historical samples use the same display-only deck registration as the
      // aircraft model, so the green line cannot appear below it near a deck.
      surfaceOffset:(reference,position)=>this.vertiportLayer?.surfaceOffset(reference,position)??0,
      // The flown line ends on the aircraft, the way the predicted one starts
      // on it: the twin's track always lags a few seconds, and without this the
      // line stops short and jumps forward each time it is asked again.
      anchor:id=>this.displayAnchor(id)});
    // People boarding and alighting across the day's decks. Off until a day is
    // being replayed, and bounded: a fixed pool of bodies spent on the walks
    // nearest the camera, so eighteen busy decks cost what one does.
    this.scenarioPassengers=new ScenarioPassengerLayer(C,v.scene,{load:loadScenarioPassengers,
      assets:id=>this.entityScene.assets?.get(id) ?? null,warning:this.onWarning,
      displayAnchor:()=>{const samples=this.entityScene.samples;
        return samples.hasClockRate?{time:samples.clockTime(performance.now()),epoch:samples.epoch}:null;}});
    // Simulation infrastructure drawn from server layouts; no definitions live here.
    // Cloud imagery is a display layer: no twin state, no entities.
    this.clouds=new CloudLayer(C,v);
    this.vertiportLayer=new VertiportLayer(C,v,{groundHeights:points=>this.groundHeights(points),
      heightAt:(longitude,latitude)=>v.scene.globe.getHeight(C.Cartographic.fromDegrees(longitude,latitude)),
      onPlaced:(id,info)=>this.onVertiportPlaced?.(id,info)});
    this.onVertiportPlaced=null;
    this.entityScene.surfaceOffset=(reference,position)=>this.vertiportLayer.surfaceOffset(reference,position);
    this.scenarioPassengers.deckTop=id=>this.vertiportLayer.deckTop(id);
    // The terminal draws its own people from the same catalogue the day's
    // boarding walks use, so there is one body model in the build.
    this.vertiportLayer.personAsset=id=>this.entityScene.assets?.get(id)??null;
    this.vertiportLayer.onWarning=this.onWarning;
    // The stand cable of a charging aircraft leaves the cabinet body the
    // vertiport layer placed, so the cable layer asks it where that is.
    this.entityScene.chargerCabinet=connection=>this.vertiportLayer.chargerCabinet(connection);
    // Routes stand on the same ground and on the vertiport decks.
    this.routeLayer=new RouteLayer(C,v,{groundHeights:points=>this.groundHeights(points),deckTop:id=>this.vertiportLayer.deckTop(id),fadeIn:true});
    // The origin-destination pairs a multi-flight setup is working with. They
    // are drawn well above the decks so they read as a network of demand
    // rather than as anything an aircraft would fly.
    this.pairLayer=new PairLayer(C,v,{placeOf:id=>{
      const frame=this.vertiportLayer.records.get(id)?.layout?.frame;
      if(!frame||!Number.isFinite(frame.longitude)||!Number.isFinite(frame.latitude))return null;
      const top=this.vertiportLayer.deckTop(id);
      return {longitude:frame.longitude,latitude:frame.latitude,height:Number.isFinite(top)?top:(frame.altitude_m??0)};
    }});
    this.demandEditor=null;this.scrap=null;
    // Airspace is drawn only when switched on; the collection waits until then.
    this.airspaceLayer=new AirspaceLayer(C,v);
    // One planned flight and the aircraft flying it; empty until a plan is made.
    this.flightLayer=new FlightLayer(C,v,{assets:id=>this.entityScene.assets?.get(id) ?? null,onWarning:this.onWarning});
    this.routeEditor=null;this.vertiportEditor=null;
    this.groundPick=null;this.pickMoveDirty=false;
    this.motion = new CameraRangeMotion(); this.scratch = new C.Cartesian3();
    this.center = new C.Cartesian2();this.pixelScratch = new C.Cartesian2();this.lastSurface=0; this.lastLod = 0;
    // tracking: the picked object, not the globe, is the camera's centre of rotation.
    this.tracking = false;this.focusRange = 0;this.focusSize = 0;
    // Where a followed simulation flight is, while one is being followed. It is
    // the camera's centre of rotation in the same way a tracked object is, so
    // the zoom distance and the terrain clamp both measure against it.
    this.flightAnchor = null;
    // Scene mode: the globe or a north-up map. A transition owns the camera
    // until it settles; input during one is ignored rather than cutting it short.
    this.sceneMode='3d';this.modeToken=0;this.modeTransition=null;this.onMode=onMode;this.onView=onView;
    v.scene.completeMorphOnUserInput=false;
    v.screenSpaceEventHandler.setInputAction(event => this.handleClick(event.position), C.ScreenSpaceEventType.LEFT_CLICK);
    // While a placement is armed the right button opens the placement tools
    // where the operator is looking instead of doing nothing.
    v.screenSpaceEventHandler.setInputAction(event => this.handleRightClick(event.position), C.ScreenSpaceEventType.RIGHT_CLICK);
    v.screenSpaceEventHandler.setInputAction(event=>{
      this.hoverPointer={x:event.endPosition.x,y:event.endPosition.y};this.hoverDirty=true;this.pickMoveDirty=true;
    },C.ScreenSpaceEventType.MOUSE_MOVE);
    v.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.onWheel=event => {
      event.preventDefault();if(this.cockpit?.active){this.cockpit.zoom(event.deltaY,event.deltaMode);return;}if(this.transitioning || this.entryActive)return;
      this.destinationPreparation?.cancel();this.clearHover();v.camera.cancelFlight();this.settleApproach();
      this.motion.wheel(this.range(), -event.deltaY, {minimum:Math.max(20,this.tracking?this.focusSize:0),maximum:60000000});
    };
    this.onPointerDown=()=>{if(this.cockpit?.active)return;if(this.transitioning || this.entryActive)return;this.destinationPreparation?.cancel();this.clearHover();this.motion.cancel();v.camera.cancelFlight();this.settleApproach();};
    this.onPointerLeave=()=>this.clearHover();
    // Keep the native menu from covering map details or placement tools.
    // RIGHT_CLICK (not RIGHT_DOWN) leaves right-button camera drags intact.
    this.onContextMenu=event=>event.preventDefault();
    v.canvas.addEventListener('contextmenu',this.onContextMenu);
    v.canvas.addEventListener('wheel',this.onWheel,{passive:false});
    v.canvas.addEventListener('pointerdown',this.onPointerDown);
    v.canvas.addEventListener('pointerleave',this.onPointerLeave);
    this.keyboard=new KeyboardNavigation({enabled:()=>this.keyboardAvailable(),
      height:()=>v.camera.positionCartographic.height-(v.scene.globe.getHeight(v.camera.positionCartographic)??0),
      move:step=>this.moveKeyboard(step)});
    this.removeFrame=v.scene.preRender.addEventListener(()=>this.frame());
    // Route markers are drawn at a size on the ground, so they are re-sized
    // whenever the camera moves: zooming out shrinks them with the map, and a
    // tilt counts as much as a zoom because it changes how far away they are.
    if(v.camera.changed){
      v.camera.percentageChanged=.02;
      this.removeCameraChange=v.camera.changed.addEventListener(()=>this.updateGroundScale());
    }
    this.onVisibility=()=>{
      v.useDefaultRenderLoop=!document.hidden;
      if(!document.hidden){this.lastLod=0;this.timing.previous=null;v.resize();v.scene.requestRender();}
    };
    document.addEventListener('visibilitychange',this.onVisibility);
    // The first rendered frame must already be the distant Earth, including
    // the frame retained by the compositor when the loading screen fades.
    ENTRY.placeStart(C, v.camera, planEntry(HOME_VIEW,{reducedMotion}));
  }
  async imagery() {
    this.imageryStatus='loading';
    const C = this.C;
    try {
      const {provider,fallback}=await loadImageryProvider(
        ()=>C.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'),
        ()=>C.TileMapServiceImageryProvider.fromUrl(C.buildModuleUrl('Assets/Textures/NaturalEarthII')));
      if(fallback)this.onWarning('고해상도 영상 연결 실패. Natural Earth 영상으로 표시합니다.');
      this.removeImageryError?.();
      this.removeImageryError=provider.errorEvent.addEventListener(error => {
        if(retryTile(error))return;
        this.imageryStatus='error';this.onWarning('지구 영상 일부를 불러오지 못했습니다. 연결을 확인해 주세요.');
      });
      const layer = this.viewer.imageryLayers.addImageryProvider(provider);
      applyImageryStyle(layer,this.viewer.scene.globe.enableLighting);
      // The base is in: the chosen Korean layers go on top of it now.
      this.vworldImagery.apply(this.vworldImagery.source,{force:true});
      this.imageryStatus='ready';
    } catch { this.imageryStatus='error';this.onWarning('지구 영상 로드 실패. 기본 타원체로 표시합니다.'); }
    void this.placeLabels.setEnabled(true);
  }
  // The programs the first zoom into a city, the first deck and the first hover
  // would otherwise compile in front of the operator, compiled now behind the
  // loading screen instead: the footprint shader with its hybrid mask, the
  // corridor fill, the textured deck and cladding, and the pick variants of
  // everything on screen. Resolves when they are drawn and taken away again.
  warmUpShaders() {
    const C=this.C,v=this.viewer;
    if(!v || v.isDestroyed?.())return Promise.resolve({primitives:0,picked:false,frames:0,failed:[],ms:0});
    let image=null;
    const deckImage=()=>image??=warmUpImage();
    // A tilted city view with the horizon in it compiles the surface programs
    // the first tilt after loading otherwise pays for (measured 0.9 s).
    // ...and the home view itself, where the first hover after the arrival
    // picks whatever stands there (measured: 14 pick variants in one 570 ms
    // hover when this view had not been picked before).
    const flights=flightShaderModels(this.entityScene.assets,this.entityScene.items.values(),id=>this.entityScene.scaleOf(id,true));
    const views=[{...HOME_VIEW,height:60000,pitch:-35},{...HOME_VIEW,height:12000,pitch:-50},
      ...(flights.length?[{...HOME_VIEW,height:700,pitch:-45}]:[]),{...HOME_VIEW}];
    // The per-instance attributes the Entity API gives its batches, in the
    // order it gives them (the order is part of the program): a fill batch
    // carries show, distance and colour; an outline batch show, colour and
    // distance; a material batch show and distance; the route corridor
    // colour and distance.
    const far=()=>new C.DistanceDisplayConditionGeometryInstanceAttribute(0,1e7);
    const show=()=>new C.ShowGeometryInstanceAttribute(true);
    const white=()=>C.ColorGeometryInstanceAttribute.fromColor(C.Color.WHITE);
    const fill=()=>({show:show(),distanceDisplayCondition:far(),color:white()});
    const outlined=()=>({show:show(),color:white(),distanceDisplayCondition:far()});
    const material=()=>({show:show(),distanceDisplayCondition:far()});
    const corridor=()=>({color:white(),distanceDisplayCondition:far()});
    // A polyline is built around the origin like the boxes (the warm-up
    // places it) and needs the vertex format of the appearance that draws it:
    // a coloured line has positions only, a material line carries texture
    // coordinates for the dashes.
    const line=vertexFormat=>({position,edge})=>new C.PolylineGeometry({positions:[position,new C.Cartesian3(position.x+edge,position.y,position.z)],width:2,
      vertexFormat,arcType:C.ArcType?.NONE});
    const facility=kind=>`/visual-assets/procedural/vertiport_facilities/${kind}.glb?v=20260917-realism`;
    return warmUpShaders({C,scene:v.scene,views,appearances:[
      // The city: opaque, unpicked, one colour per building.
      {name:'footprint',allowPicking:false,appearance:()=>footprintAppearance(C,this.vworldBuildings?.uniforms??{})},
      // Route corridors and the deck's own primitives while it is being placed.
      {name:'corridor',attributes:corridor,appearance:()=>new C.PerInstanceColorAppearance({flat:true,translucent:true,closed:false})},
      {name:'preview-deck',textured:true,appearance:()=>texturedAppearance(C,deckImage())},
      {name:'preview-cabinet',textured:true,appearance:()=>texturedAppearance(C,deckImage(),1,{closed:true})},
      // Entity batches: the platform mass, FATO columns and their outlines,
      // the clad walls and painted deck, each as drawn and as faded for an edit.
      {name:'platform',attributes:fill,appearance:()=>new C.PerInstanceColorAppearance({translucent:false,closed:true})},
      {name:'platform-faded',attributes:fill,appearance:()=>new C.PerInstanceColorAppearance({translucent:true,closed:true})},
      // The stand cable and its plug: a colour per instance, nothing else, and
      // never picked (charging_cables.js).
      {name:'cable',allowPicking:false,attributes:()=>({color:white()}),appearance:()=>new C.PerInstanceColorAppearance({translucent:false,closed:true})},
      // The colonnade, terrace and steps under a building: shown or not, and a
      // colour (vertiport_base.js). Faded for the building being edited.
      {name:'base',attributes:()=>({show:show(),color:white()}),appearance:()=>new C.PerInstanceColorAppearance({translucent:false,closed:true})},
      {name:'base-faded',attributes:()=>({show:show(),color:white()}),appearance:()=>new C.PerInstanceColorAppearance({translucent:true,closed:true})},
      // An open (not closed) solid is lit face-forward: its own program.
      {name:'open',attributes:fill,appearance:()=>new C.PerInstanceColorAppearance({translucent:false,closed:false})},
      {name:'open-faded',attributes:fill,appearance:()=>new C.PerInstanceColorAppearance({translucent:true,closed:false})},
      {name:'outline',outline:true,attributes:outlined,appearance:()=>new C.PerInstanceColorAppearance({flat:true,translucent:false,renderState:{lineWidth:1}})},
      {name:'outline-faded',outline:true,attributes:outlined,appearance:()=>new C.PerInstanceColorAppearance({flat:true,translucent:true,renderState:{lineWidth:1}})},
      {name:'wall',textured:true,attributes:material,appearance:()=>texturedAppearance(C,deckImage())},
      {name:'wall-faded',textured:true,attributes:material,appearance:()=>texturedAppearance(C,deckImage(),1,{translucent:true})},
      // Route lines, plain and dashed.
      {name:'polyline',geometry:line(C.PolylineColorAppearance?.VERTEX_FORMAT),attributes:fill,appearance:()=>new C.PolylineColorAppearance({translucent:true})},
      {name:'polyline-dash',geometry:line(C.PolylineMaterialAppearance?.VERTEX_FORMAT),attributes:material,appearance:()=>new C.PolylineMaterialAppearance({translucent:true,material:C.Material.fromType('PolylineDash',{color:C.Color.WHITE,dashLength:16})})},
    ],collections:[
      // The entity layers' points and markers, opaque and translucent: an
      // aircraft point fades by distance (a fade that changes nothing would
      // leave the program without its fade: the values must differ from 1);
      // a route node or vertiport marker shares its collection with those
      // and adds a display distance; a marker image is rotated.
      {name:'points',collection:({edge})=>{
        const points=new C.PointPrimitiveCollection(),fade=new C.NearFarScalar(0,.9,1e12,.9);
        points.add({position:new C.Cartesian3(0,0,0),pixelSize:8,color:C.Color.WHITE,translucencyByDistance:fade});
        points.add({position:new C.Cartesian3(edge,0,0),pixelSize:8,color:C.Color.WHITE.withAlpha(.5),translucencyByDistance:fade});
        return points;}},
      {name:'markers',collection:({edge})=>{
        const points=new C.PointPrimitiveCollection(),fade=new C.NearFarScalar(0,.9,1e12,.9),within=new C.DistanceDisplayCondition(0,1e7);
        points.add({position:new C.Cartesian3(0,0,0),pixelSize:9,color:C.Color.WHITE,translucencyByDistance:fade});
        points.add({position:new C.Cartesian3(edge,0,0),pixelSize:9,color:C.Color.WHITE,disableDepthTestDistance:0,distanceDisplayCondition:within});
        points.add({position:new C.Cartesian3(0,edge,0),pixelSize:9,color:C.Color.WHITE.withAlpha(.5),disableDepthTestDistance:0,distanceDisplayCondition:within});
        return points;}},
      {name:'billboards',collection:({edge})=>{
        const billboards=new C.BillboardCollection(),fade=new C.NearFarScalar(0,.9,1e12,.9);
        billboards.add({position:new C.Cartesian3(0,0,0),image:deckImage(),rotation:.3,color:C.Color.WHITE,translucencyByDistance:fade});
        billboards.add({position:new C.Cartesian3(edge,0,0),image:deckImage(),rotation:.3,color:C.Color.WHITE.withAlpha(.5),translucencyByDistance:fade});
        return billboards;}},
    ],models:[
      // Distant/underground anchors do not compile the near-ground atmosphere
      // variants. Carry the actual rigs through the near view while loading.
      ...flights,
      // The cabinet and shelter every deck stands, as drawn and as faded.
      {name:'charger',url:facility('charging_station'),color:C.Color.WHITE.withAlpha(1)},
      {name:'shelter',url:facility('boarding_pavilion'),color:C.Color.WHITE.withAlpha(1)},
      {name:'charger-faded',url:facility('charging_station'),color:C.Color.WHITE.withAlpha(.3)},
      {name:'shelter-faded',url:facility('boarding_pavilion'),color:C.Color.WHITE.withAlpha(.3)},
    ]}).then(result=>{this.shaderWarmUp=result;return result;});
  }
  waitForInitialView(options={}) {
    return waitForInitialView({scene:this.viewer.scene,...options,read:()=>({
      imagery:this.imageryStatus,
      terrain:!this.terrain?'ready':this.terrain.tileError?'error':this.terrain.ready?'ready':this.terrain.lastStatus || 'loading',
      tilesLoaded:this.viewer.scene.globe.tilesLoaded
    })});
  }
  setPlaceNamesEnabled(enabled) {return this.placeLabels.setEnabled(enabled);}
  setSunEnabled(enabled) {setSunLighting(this.viewer.scene,enabled);this.viewer.scene.requestRender();}
  setBuildingsEnabled(enabled) {this.buildingsEnabled=Boolean(enabled);this.applyBuildingProvider();}
    // Hybrid combines nearby photo tiles with a bounded footprint fallback.
    // Providers outside the chosen mode stop requesting data.
  setBuildingsProvider(provider) {this.buildingProvider=['vworld','vworld_3d','vworld_hybrid'].includes(provider)?provider:'osm';this.applyBuildingProvider();}
  setBuildingAppearance(values={}) {
    this.buildingAppearance={quality:values.quality??'balanced',opacity:values.opacity??.9,distance:values.distance??'auto',
      tint:values.tint??'neutral',brightness:values.brightness??1};
    this.osmBuildingFocus?.setAppearance(this.buildingAppearance);
    this.vworld3dFocus?.setAppearance(this.buildingAppearance);
    this.vworldBuildings?.setAppearance(this.buildingAppearance);
    // A tileset is recoloured by being handed a new style; the extruded layer
    // does it in its own shader, which is why only these two need telling.
    this.restyleBuildingTilesets();
    this.viewer.scene.requestRender();
  }
  restyleBuildingTilesets() {
    const look=appearanceOf(this.buildingAppearance);
    for(const tiles of [this.osmTiles,this.vworld3d?.tileset])if(tiles)tiles.style=buildingStyle(this.C,look);
  }
  applyBuildingProvider() {
    this.buildings.setEnabled(this.buildingsEnabled && this.buildingProvider==='osm');
    const hybrid=this.buildingProvider==='vworld_hybrid';
    this.vworldBuildings.setEnabled(this.buildingsEnabled && (this.buildingProvider==='vworld'||hybrid));
    this.vworld3d?.setEnabled(this.buildingsEnabled && (this.buildingProvider==='vworld_3d'||hybrid));
    this.hybridBuildings?.setEnabled(this.buildingsEnabled&&hybrid);
  }
  // Which imagery draws Korea; anything unknown is the world imagery alone.
  setImagerySource(source) {this.vworldImagery.apply(source ?? BASE_SOURCE);}
  // Flat ground: the World Terrain heights are swapped for the ellipsoid and
  // restored on demand. Buildings follow the terrain gate, since their bases
  // are baked to World Terrain and would float above a flat surface.
  attachTerrain(provider) {
    if(this.terrainFlat)this.savedTerrainProvider=provider;
    else this.viewer.terrainProvider=provider;
    this.surface.anchor=null;this.lastLod=0;
    this.viewer.scene.requestRender();this.vworldBuildings?.rebuild();
    void this.vertiportLayer?.refresh().then(()=>this.routeLayer?.refresh());
  }
  async setTerrainSource(source) {
    const wanted=['local_dem','conditioned_dem'].includes(source)?source:'world_terrain';
    this.terrainSource=wanted;
    const revision=++this.terrainRevision;
    if(!this.worldTerrain)return;
    const key=wanted==='conditioned_dem'?'conditionedTerrain':'localTerrain';
    const pendingKey=key+'Pending';
    if(this.activeTerrainSource===wanted && (wanted==='world_terrain' || this[key]))return;
    let next=this.worldTerrain,actual='world_terrain';
    if(wanted!=='world_terrain') {
      const label=wanted==='conditioned_dem'?'보정 DEM':'로컬 DEM';
      try {
        if(!this[key] && !this[pendingKey])this[pendingKey]=loadLocalTerrain(this.C,this.worldTerrain,{
          source:wanted==='conditioned_dem'?'conditioned':'local',
          onFallback:()=>{if(!this[key+'Warned']){this[key+'Warned']=true;this.onWarning(`${label} 일부를 읽지 못해 Cesium 지형으로 대체했습니다.`);}}
        }).then(provider=>this[key]=provider).finally(()=>{this[pendingKey]=null;});
        next=this[key] || await this[pendingKey];actual=wanted;
      } catch {if(revision===this.terrainRevision)this.onWarning(`${label} 연결 실패. 기존 Cesium 지형을 유지합니다.`);}
    }
    if(revision!==this.terrainRevision || this.terrainDisposed)return;
    this.activeTerrainSource=actual;
    this.attachTerrain(next);this.onTerrainStatus('ready');
  }
  setTerrainEnabled(enabled) {
    const C=this.C,v=this.viewer,flat=!enabled;
    if(flat===Boolean(this.terrainFlat))return;
    this.terrainFlat=flat;
    if(flat){this.buildings.setSurfaceReady(false);this.vworld3d?.setSurfaceReady(false);}
    if(flat){this.savedTerrainProvider=v.terrainProvider;v.terrainProvider=new C.EllipsoidTerrainProvider();}
    else if(this.savedTerrainProvider){v.terrainProvider=this.savedTerrainProvider;this.savedTerrainProvider=null;}
    this.surface.anchor=null;this.lastLod=0;
    this.onTerrainFlat(flat);v.scene.requestRender();
    this.vworldBuildings?.rebuild();
    void this.vertiportLayer?.refresh().then(()=>this.routeLayer?.refresh());
  }
  // How big each airframe is drawn. A scheduled day says so, because the
  // library's acquired models carry no agreed real-world size.
  setModelSpans(spans){this.entityScene.setModelSpans(spans);this.requestRender?.();}
  // People on the decks belong to a day being replayed. Off otherwise: the live
  // twin has no schedule to say who is boarding.
  setScenarioPassengers(shown){this.scenarioPassengers?.setShown(shown);this.viewer?.scene?.requestRender?.();}
  // A picture of the map as it is now. Cesium clears the drawing buffer after
  // each frame, so the frame is drawn and read in the same synchronous block —
  // a render on one task and a read on the next gives a blank image.
  // The mark to stamp on a capture: the one the page is already showing, or the
  // copy fetched in the background when the page has none. Never awaited — a
  // capture must not wait on an image, and one without the mark is still a
  // capture.
  brandMark() {
    return shownMark(globalThis.document) ?? this.mark ?? null;
  }
  // The scene's canvas with the mark on it, at the size the scene is drawn.
  brandedFrame(source=this.viewer.scene.canvas) {
    const canvas=this.brandCanvas ??= globalThis.document.createElement('canvas');
    if(canvas.width!==source.width || canvas.height!==source.height){
      canvas.width=source.width;canvas.height=source.height;this.brandContext=null;
    }
    this.brandContext ??= canvas.getContext('2d',{alpha:false});
    return drawBranded(this.brandContext,source,this.brandMark())?canvas:null;
  }
  captureImage(name='aerodt.png') {
    try {
      const scene=this.viewer.scene;
      scene.initializeFrame();scene.render();
      const framed=this.brandedFrame(scene.canvas);
      const url=(framed ?? scene.canvas).toDataURL('image/png');
      if(!url || url.length<128)return false;
      return this.save(url,name);
    } catch {return false;}
  }
  // A recording of the map, taken straight off the scene's own canvas. The
  // browser writes the file; nothing is sent anywhere and the twin is not
  // involved.
  //
  // No mark is stamped on it, deliberately. Nothing can be drawn into a WebGL
  // canvas from outside, so a mark means copying every frame into a canvas of
  // our own — and this canvas does not preserve its drawing buffer, so a copy
  // taken any later than the render that filled it gets a cleared one. The map
  // then comes out black under the mark, flickering as the two race. Recording
  // the canvas itself has no such race. A still is different: it is drawn and
  // read in one block, so it carries the mark.
  startRecording(name='aerodt.webm') {
    if(this.recorder)return true;
    try {
      const source=this.viewer.scene.canvas;
      const stream=source.captureStream?.(RECORDING_FPS);
      if(!stream)return false;
      const type=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']
        .find(candidate=>globalThis.MediaRecorder?.isTypeSupported?.(candidate));
      const recorder=new globalThis.MediaRecorder(stream,
        {...(type?{mimeType:type}:{}),videoBitsPerSecond:recordingBitrate(source.width,source.height,RECORDING_FPS)});
      const chunks=[];
      recorder.ondataavailable=event=>{if(event.data?.size)chunks.push(event.data);};
      recorder.onstop=()=>{
        const url=URL.createObjectURL(new Blob(chunks,{type:type ?? 'video/webm'}));
        this.save(url,this.recordingName ?? name);
        setTimeout(()=>URL.revokeObjectURL(url),4000);
      };
      recorder.start(1000);
      this.recorder=recorder;this.recordingName=name;
      return true;
    } catch {this.recorder=null;return false;}
  }
  stopRecording() {
    const recorder=this.recorder;
    this.recorder=null;
    try {recorder?.stop();} catch {}
    return Boolean(recorder);
  }
  save(url,name) {
    const link=document.createElement('a');
    link.href=url;link.download=name;document.body.append(link);link.click();link.remove();
    return true;
  }
  setAssets(catalog) {
    this.entityScene.setAssets(catalog);
    // A flight drawn before the catalogue arrived is still waiting for its
    // model; the catalogue is what it was waiting for.
    void this.flightLayer?.retryModel();
  }
  setLayerVisible(kind,visible) {
    this.clearHover();
    if(!visible && this.items.get(this.selected)?.entity.kind===kind)this.select(null);
    this.entityScene.setLayerVisible(kind,visible);this.lastLod=0;
    this.viewer.scene.requestRender();
  }
  setEntityDisplay(kind,state) {
    this.entityScene.setDisplayOptions(kind,state);
    this.setLayerVisible(kind,state.all!==false);
  }
  // Everything from one source leaves the map at once. The selection and the
  // hover go with it: pointing at an aircraft that is no longer there would
  // keep a panel open on a state nothing is producing any more.
  // The source is expected on the map again; see EntityScene.dropSource.
  ownSource(source) {return this.entityScene.ownSource(source);}
  dropSource(source) {
    const dropped=this.entityScene.dropSource(source);
    if(this.selected && !this.items.has(this.selected))this.select(null,{preserveDetails:true});
    else if(this.detailId && !this.items.has(this.detailId))this.refreshDetails();
    if(this.entityScene.hoveredId && !this.items.has(this.entityScene.hoveredId))this.clearHover();
    return dropped;
  }
  replace(snapshot) {
    this.entityScene.replace(snapshot);
    if(this.selected && !this.items.has(this.selected))this.select(null,{preserveDetails:true});
    else if(this.selected || this.detailId)this.refreshDetails();
    if(this.entityScene.hoveredId && !this.items.has(this.entityScene.hoveredId))this.clearHover();
  }
  pickInteraction(position,picked=pickThroughAirspace(this.viewer.scene,position)) {
    if(this.scrap||this.groundPick||this.routeEditor||this.demandEditor||this.vertiportEditor)return picked;
    return pickNearbyUam(this.C,this.viewer.scene,position,picked,this.entityScene,this.flightLayer);
  }
  pickEntity(position,picked=pickThroughAirspace(this.viewer.scene,position),resolved=false) {
    if(!resolved)picked=this.pickInteraction(position,picked??null);
    const id=picked?.id,item=this.items.get(id);
    return typeof id==='string' && item && item.lod!=='hidden' && this.entityScene.layers[item.entity.kind].visible?id:null;
  }
  clearHover() {
    this.hoverAirspace=null;this.hoverFlight=false;
    this.hoverPointer=null;this.hoverDirty=false;this.entityScene.setHovered(null);this.routeLayer?.hover(null);this.vertiportLayer?.setHovered(null);
    this.viewer.canvas.style.cursor=this.groundPick?'crosshair':'';this.onHover(null);
  }
  is2D() {return Boolean(this.C.SceneMode) && this.viewer.scene.mode===this.C.SceneMode.SCENE2D;}
  get transitioning() {return (this.modeTransition ?? null)!==null || (Boolean(this.C.SceneMode) && this.viewer.scene.mode===this.C.SceneMode.MORPHING);}
  // The altitude the display policies key on: camera height over the globe,
  // or the map width in 2D, which Cesium hands over equal to the height it replaced.
  viewHeight() {
    const camera=this.viewer.camera;
    return this.is2D()?camera.frustum.right-camera.frustum.left:camera.positionCartographic.height;
  }
  // How much ground one pixel covers where the camera is looking. The globe's
  // perspective frustum and the map's orthographic one both answer this, so a
  // marker drawn at a size on the ground is that size in either view.
  groundScale() {
    const v=this.viewer,frustum=v.camera.frustum;
    const width=v.canvas.clientWidth,height=v.canvas.clientHeight;
    if(!frustum?.getPixelDimensions || !(width>0) || !(height>0))return 0;
    const size=frustum.getPixelDimensions(width,height,this.range(),v.scene.pixelRatio ?? 1,this.pixelScratch);
    return Number.isFinite(size?.y) && size.y>0?size.y:0;
  }
  // The camera moved: what is drawn at a size on the ground is re-sized. The
  // arrival and a mode change own the camera; nothing is re-sized under them.
  updateGroundScale() {
    if(this.entryActive || this.transitioning)return;
    const scale=this.groundScale();
    const routesChanged=this.routeLayer.setPixelScale(scale);
    const airspaceChanged=this.airspaceLayer?.setPixelScale(scale);
    if(routesChanged || airspaceChanged)this.viewer.scene.requestRender();
  }
  range() {
    const C=this.C, v=this.viewer;
    if(this.is2D())return v.camera.frustum.right-v.camera.frustum.left;
    const centred=this.tracking?this.items.get(this.selected):null;
    if (centred) return this.trackingAnchor?C.Cartesian3.magnitude(v.camera.position):C.Cartesian3.distance(v.camera.positionWC,centred.position);
    // Following a flight, the distance that matters is to the aircraft. Read
    // off the ground under the screen centre instead, a wheel notch would be
    // scaled to the terrain far below it and overshoot wildly.
    if (this.flightAnchor) return C.Cartesian3.distance(v.camera.positionWC,this.flightAnchor);
    this.center.x=v.canvas.clientWidth/2;this.center.y=v.canvas.clientHeight/2;
    const target=pickGround(v.camera,v.scene,this.center,this.scratch);
    return target ? C.Cartesian3.distance(v.camera.positionWC,target) : Math.max(20,v.camera.positionCartographic.height);
  }
  zoom(factor) {if(this.cockpit?.active){this.cockpit.zoom(Math.log(factor)*500,0);return;}this.destinationPreparation?.cancel();this.viewer.camera.cancelFlight();this.motion.moveTo(this.range(),Math.max(20,Math.min(60000000,this.range()*factor)));}
  setRange(range) {if(this.cockpit?.active)return;this.destinationPreparation?.cancel();this.viewer.camera.cancelFlight();this.motion.moveTo(this.range(),range);}
  select(id,{focus=false,preserveDetails=false}={}) {
    if(!preserveDetails)this.detailId=null;
    this.clearHover();
    // Re-picking the centred object toggles tracking, not the detail selection.
    if(focus && id!==null && id===this.selected && (this.tracking || this.approaching)){
      this.stopTracking();this.onSelect(this.items.get(id)?.entity || null,{selected:true});return;
    }
    const centred=id!==null && id===this.selected && this.tracking;
    if(!centred)this.stopTracking();
    const old=this.items.get(this.selected);
    if(old && old!==this.items.get(id)){old.selected=false;this.entityScene.applyVisibility(old,false);}
    this.selected=id;const item=this.items.get(id);if(item){item.selected=true;this.entityScene.applyVisibility(item,true);}
    this.lastLod=0;this.refreshDetails({selected:true});
    void this.trajectory.show(item?.entity || null);
    void this.flightTrack?.show(item?.entity || null,{force:true});
    // A pick means "show me this one": approach it and orbit it from then on.
    if(focus && item && !centred)this.focus(true);
  }
  springTarget(target,key,now,range,stateTime=this.entityScene.samples?.stateTime){
    const arm=this.cameraSpring ??= new CameraSpringArm();
    if(Number.isFinite(stateTime)&&stateTime<this.springStateTime)arm.reset();
    this.springStateTime=stateTime;
    const epoch=this.entityScene.samples?.epoch??0;
    const continuity=this.items.get(this.selected)?.entity?.continuity_id??0;
    const position=arm.update(target,now,`${key}:${epoch}:${continuity}`,Math.min(1,Math.max(0,Number.isFinite(range)?range*.003:0)));
    // Centre lock: only 0.3% of viewing range (at most 1 m) may be damped.
    // Translation follows immediately outside this tiny jitter envelope; the
    // display target and user orbit/zoom remain untouched.
    return this.C.Cartesian3.clone(position,this.trackingAnchor ??= new this.C.Cartesian3());
  }
  // `keepPose` is for a caller that is about to put the camera somewhere
  // itself. `focus` flies from where the camera is now, so letting the
  // cockpit snap back to where the pilot had been standing first meant the
  // approach started at the vertiport they had been looking at and flew in
  // from there -- the view went away from the aircraft before coming to it.
  // A stop nobody asked for still restores that pose: there is then nothing
  // left to look at where the camera is standing.
  stopTracking(keepPose=false) {
    if(this.cockpit?.active)this.cockpit.exit(false,keepPose);
    this.cameraSpring?.reset();this.trackingAnchor=null;this.springStateTime=undefined;this.followedFlightSample=null;
    this.destinationPreparation?.cancel();
    this.approach=null;this.approaching=false;this.clearPreload();
    // The camera's frame is about to be reset, so a flight it was riding with
    // is no longer being ridden: the next follow starts its arm afresh.
    this.flightAnchor=null;
    this.tracking=false;this.focusSize=0;this.lastLod=0;
    this.motion.cancel();this.viewer.camera.cancelFlight();
    this.viewer.camera.lookAtTransform(this.C.Matrix4.IDENTITY);
  }
  // Viewing angle in the object's local frame: never from below, never a pure
  // overhead dot, and otherwise the direction the operator already had.
  viewAngle() {
    const c=this.viewer.camera;
    return {heading:Number.isFinite(c.heading)?c.heading:0,
      pitch:Number.isFinite(c.pitch)?Math.max(-1.4,Math.min(-.2,c.pitch)):-.5};
  }
  // Start an object's model loading without moving the camera to it.
  //
  // Loading the airframe is the longest part of arriving at an aircraft, and it
  // is the one part that does not need the camera to be there. `focus` asks for
  // it too, but only once it is flying the approach -- so entering a cockpit ran
  // the glide and the load end to end. Asking here lets whatever is flying the
  // camera overlap the two instead. Cheap to repeat: the load is skipped once
  // the model exists or is already on its way, and repeating it keeps the model
  // from being trimmed out from under a long glide.
  prepareModel(id,now=this.motion.now()) {
    const item=this.items.get(id);
    return item?Boolean(this.entityScene?.prepareFocus?.(item,now)):false;
  }
  focus(track = true, now = this.motion.now(),{departure=false}={}) {
    const item=this.items.get(this.selected);if (!item) return;
    const C=this.C,camera=this.viewer.camera;
    // Keeping the pose: the approach below is measured from where the camera
    // is now, and inside the cockpit that is at the aircraft.
    this.stopTracking(true);
    // A known model size gives a framing that suits the actual vehicle.
    const size=this.entityScene.assets?.get(item.assetId)?.size_m ?? 0;
    const framing=size>0?Math.min(3000,Math.max(300,size*8)):(item.entity.kind==='satellite'?1500:600);
    // Never further away than the operator already is. Picking something from
    // close up asks for a look at it, not for the camera to back off to a
    // standard framing, which reads as the view running away from the thing
    // that was just clicked. The floor keeps the camera out of the model.
    const floor=Math.max(20,size*1.5);
    const held=distance=>Number.isFinite(distance) && distance>0
      ? Math.min(framing,Math.max(floor,distance)) : framing;
    this.focusSize=size;
    const {heading,pitch}=this.viewAngle(),map=this.is2D();
    // The object keeps moving while the camera closes in, so the approach is
    // flown in the object's own frame: from where the camera is now relative
    // to the object to the chosen framing, recomputed every frame. A flight
    // towards the position at click time lands beside the object and snaps.
    // The pose is set in the world frame and the orientation blends from the
    // operator's view, so the object glides from where it was clicked to the
    // centre; anchoring on the first frame would swing it there at once.
    // On the map the same path is a pan and zoom: centre and width.
    this.entityScene.refreshPosition(item,now);
    if(map){
      const centre=camera.positionCartographic,width0=this.range();
      // On the map the same rule is about width: already tighter than the
      // framing means keep the width and only pan to it.
      const width1=mapWidthForRange(held(width0/2));
      this.focusRange=width1/2;
      this.approach={id:this.selected,map:true,centre0:{longitude:centre.longitude,latitude:centre.latitude},width0,width1,
        startedAt:now,track,duration:approachDuration(width0,width1)};
    } else {
      const start=localOffset(C,item.position,camera.positionWC,new C.Cartesian3());
      const range=held(C.Cartesian3.magnitude(start));
      this.focusRange=range;
      const end=offsetFromHeadingPitchRange(heading,pitch,range,new C.Cartesian3());
      const view=approachView(camera.positionWC,camera.directionWC,camera.upWC,item.position,
        C.Ellipsoid.WGS84.geodeticSurfaceNormal(item.position,this.upScratch ??= new C.Cartesian3()));
      this.approach={id:this.selected,map:false,start,end,...view,startedAt:now,track,departure,
        clearance:Math.max(60,size*2.5),
        duration:approachDuration(C.Cartesian3.magnitude(start),range)};
    }
    // Give the picked model its own load slot before entering its close-up.
    // The wait is bounded: unavailable/slow assets must never lock navigation.
    if(!map && this.entityScene.prepareFocus?.(item,now))this.approach.prepareUntil=now+250;
    this.focusPriorityUntil=now+2500;
    this.approaching=track;this.tracking=false;this.lastLod=0;
    this.stepApproach(now);
  }
  // Land a running approach now, in one frame, at the framing it was flying to.
  //
  // Entering a cockpit does not need the journey: a loading screen covers the
  // map until the seat is ready, so the flight would be seconds the operator
  // spends watching nothing. What is still wanted is where the approach *ends* --
  // the camera anchored on the aircraft at its framing, tracking it -- because
  // that is the view they are handed back when they leave the cockpit, and it is
  // what the external follow is built on. Dropping the approach altogether would
  // have left them wherever they happened to be looking beforehand.
  finishApproach(now=this.motion.now()) {
    const approach=this.approach;if(!approach)return false;
    // The 250 ms model hold has nothing left to wait for here: the seat is only
    // asked for once the model is ready.
    approach.prepareUntil=0;
    this.stepApproach(Math.max(now,(approach.frameAt??approach.startedAt)+(approach.duration??0)+1));
    return !this.approach;
  }
  // One frame of the approach; true while it is flying. It ends anchored to
  // the object at the framing, or released again if the pick asked for no orbit.
  stepApproach(now,{maxStep=Infinity}={}) {
    const approach=this.approach;if(!approach)return false;
    const target=this.items.get(approach.id);
    if(!target || this.selected!==approach.id){this.stopTracking();return false;}
    const C=this.C,camera=this.viewer.camera;
    let step=Math.max(0,Math.min(maxStep,now-(approach.frameAt??approach.startedAt)));
    approach.frameAt=now;
    if(approach.prepareUntil){
      step=0;
      if((!target.loading&&target.model?.ready!==false) || now>=approach.prepareUntil)approach.prepareUntil=0;
    }
    // Only camera animation is bounded after a missed render. Entity positions
    // still sample the real display clock; physics/replay time is not slowed.
    approach.elapsed=(approach.elapsed??0)+step;
    const t=approach.progress=cameraEase(Math.min(1,approach.elapsed/approach.duration));
    this.entityScene.refreshPosition(target,now);
    if(approach.map){
      const goal=C.Cartographic.fromCartesian(target.position,C.Ellipsoid.WGS84,this.cartographicScratch ??= new C.Cartographic());
      const width=t<=0?approach.width0:t>=1?approach.width1:Math.exp(Math.log(approach.width0)+(Math.log(approach.width1)-Math.log(approach.width0))*t);
      const c0=approach.centre0;
      camera.setView({destination:C.Cartesian3.fromRadians(c0.longitude+(goal.longitude-c0.longitude)*t,c0.latitude+(goal.latitude-c0.latitude)*t,width)});
    } else {
      const frame=C.Transforms.eastNorthUpToFixedFrame(target.position,C.Ellipsoid.WGS84,this.frameScratch ??= new C.Matrix4());
      const pose=approachPose(approach,t,target.position,(offset,result)=>C.Matrix4.multiplyByPoint(frame,offset,result),
        C.Ellipsoid.WGS84.geodeticSurfaceNormal(target.position,this.upScratch ??= new C.Cartesian3()),
        this.poseScratch ??= {offset:new C.Cartesian3(),position:new C.Cartesian3(),aim:new C.Cartesian3(),upAtAim:new C.Cartesian3(),right:new C.Cartesian3(),axis:new C.Cartesian3(),direction:new C.Cartesian3(),up:new C.Cartesian3()});
      camera.setView({destination:pose.position,orientation:{direction:pose.direction,up:pose.up}});
      this.approachDetail=motionScreenSpaceError(t);
      if(t<1)this.preloadDestination(approachPose(approach,1,target.position,(offset,result)=>C.Matrix4.multiplyByPoint(frame,offset,result),
        this.upScratch,this.goalScratch ??= {offset:new C.Cartesian3(),position:new C.Cartesian3(),aim:new C.Cartesian3(),upAtAim:new C.Cartesian3(),right:new C.Cartesian3(),axis:new C.Cartesian3(),direction:new C.Cartesian3(),up:new C.Cartesian3()}));
    }
    if(t>=1)this.endApproach(target,1);
    return true;
  }
  // While the camera is on its way, Cesium loads tiles for wherever it is at
  // that moment. Its flight-preload camera, the one its own flights use, is
  // pointed at where this approach will land, so the ground under the object
  // is largely loaded by the time the camera arrives instead of sharpening
  // in front of the operator afterwards. Cleared as soon as the approach ends.
  preloadDestination(pose) {
    const C=this.C,scene=this.viewer.scene,camera=this.viewer.camera,pre=scene.preloadFlightCamera,frustum=camera.frustum;
    if(!pre || !('preloadFlightCullingVolume' in scene) || typeof frustum?.clone!=='function')return;
    C.Cartesian3.clone(pose.position,pre.position);C.Cartesian3.clone(pose.direction,pre.direction);C.Cartesian3.clone(pose.up,pre.up);
    C.Cartesian3.cross(pre.direction,pre.up,pre.right);frustum.clone(pre.frustum);
    scene.preloadFlightCullingVolume=pre.frustum.computeCullingVolume(pre.positionWC,pre.directionWC,pre.upWC);
    // Cesium runs the preload pass only while one of its own flights is
    // active. This approach is that flight; the instance override is removed
    // with the preload so the prototype answer returns afterwards.
    if(typeof camera.canPreloadFlight==='function' && !Object.hasOwn(camera,'canPreloadFlight'))camera.canPreloadFlight=()=>true;
  }
  clearPreload() {
    const scene=this.viewer.scene,camera=this.viewer.camera;
    if('preloadFlightCullingVolume' in scene)scene.preloadFlightCullingVolume=undefined;
    if(Object.hasOwn(camera,'canPreloadFlight'))delete camera.canPreloadFlight;
    this.approachDetail=0;
  }
  // Input during an approach keeps the object centred at the distance reached.
  settleApproach() {
    const approach=this.approach,target=approach && this.items.get(approach.id);
    if(!target){this.approach=null;return;}
    this.endApproach(target,approach.progress??0);
  }
  // Anchor on the object at the progress reached: from here on the object,
  // not the globe, is the centre of rotation (or the camera is released).
  endApproach(target,t) {
    const approach=this.approach,{track}=approach;this.approach=null;this.approaching=false;this.lastLod=0;this.clearPreload();
    const offset=approach.map
      ?mapOffset(t<=0?approach.width0:t>=1?approach.width1:Math.exp(Math.log(approach.width0)+(Math.log(approach.width1)-Math.log(approach.width0))*t),this.scratch)
      :(approach.departure
        ?departureOffset(approach.start,approach.end,t,approach.clearance,this.scratch)
        :approachOffset(approach.start,approach.end,t,this.scratch));
    this.cameraSpring?.reset();this.trackingAnchor=null;
    this.viewer.camera.lookAt(target.position,offset);
    this.tracking=track;if(!track)this.stopTracking();
    this.refreshDetails();
  }
  orient(topDown = false) {
    if(this.is2D() || this.transitioning)return; // a map is already north-up and top-down
    const C=this.C,c=this.viewer.camera; this.motion.cancel();this.settleApproach();
    const centred=this.tracking?this.items.get(this.selected):null;
    if(centred){
      // Re-aim around the centred object rather than releasing it.
      const pitch=topDown?-Math.PI/2:this.viewAngle().pitch;
      c.lookAt(this.trackingAnchor??centred.position,new C.HeadingPitchRange(0,pitch,this.range()));
      return;
    }
    this.stopTracking();
    c.flyTo({destination:c.positionWC.clone(),orientation:{heading:0,pitch:topDown?-Math.PI/2:c.pitch,roll:0},duration:.8});
  }
  // Camera-only arrival; normal navigation resumes over the Seoul city view.
  entry({reducedMotion=false,prepare=false,beforeReveal=()=>{}}={}) {
    this.motion.cancel();this.stopTracking();
    this.entryActive=true;
    // Restart the fades rather than replacing them: a new RouteGeometryFade has
    // forgotten what colour the network is, and if it is asked while the network
    // is faded out it records transparent as full strength and the network never
    // comes back. Only the clock is meant to be reset here.
    this.infrastructureLabelFade?.restart();
    this.routeGeometryFade?.restart();
    this.annotationStamp=null;
    this.arrivalFadeUntil=0;
    this.placeLabels?.setSuspended(true);
    this.entryAbort=new AbortController();
    const inputs=this.viewer.scene.screenSpaceCameraController;
    const previousInputs=inputs.enableInputs;inputs.enableInputs=false;
    // No live-model LOD/load competition during the camera arrival. Preserve
    // the operator's layer choices and restore the same collections afterwards.
    const hidden=[],seenCollections=new Set();
    for(const layer of Object.values(this.entityScene.layers))for(const key of ['points','billboards','labels','models']){
      const collection=layer[key];
      // UAM, drone and bird alias the same collections. Capture their original
      // visibility once, before hiding; a second capture would store false.
      if(!collection||seenCollections.has(collection))continue;
      seenCollections.add(collection);
      hidden.push([collection,collection.show]);collection.show=false;
    }
    const infrastructure=[this.routeLayer,this.vertiportLayer].filter(Boolean).map(layer=>[layer,layer.visible]);
    for(const [layer] of infrastructure)layer.setVisible(false);
    const plan=planEntry(HOME_VIEW,{reducedMotion});
    const terrainError=this.viewer.scene.globe?.maximumScreenSpaceError;
    this.onEntry?.(true);
    const fly=()=>ENTRY.fly(this.C,this.viewer.camera,HOME_VIEW,{scene:this.viewer.scene,reducedMotion,plan,signal:this.entryAbort.signal});
    const first=fly();
    // Keep the same hidden layers, shader cache and render budget between the
    // covered preparation and the visible flight. Restoring live layers here
    // would compile their programs in the middle of the visible arrival again.
    return (prepare?first.then(async result=>{
      if(result==='cancel')throw new Error('서울 진입 준비가 취소되었습니다.');
      await beforeReveal();
      return fly();
    }):first)
      .finally(()=>{this.entryActive=false;inputs.enableInputs=previousInputs;
        if(this.viewer.scene.globe&&terrainError!==undefined)this.viewer.scene.globe.maximumScreenSpaceError=terrainError;
        this.entityScene.fadeLabelsIn?.(performance.now(),ARRIVAL_FADE_MS);
        this.placeLabels?.setSuspended(false,ARRIVAL_FADE_MS);
        for(const [collection,show] of hidden)if(!collection.isDestroyed?.())collection.show=show;
        if(!this.viewer.isDestroyed?.())for(const [layer,visible] of infrastructure)layer.setVisible(visible);
        // Everything the arrival held back is visible again from this line on.
        // Fading it in is not enough on its own: the first frame after it is
        // shown would be drawn at full strength, and only the frame after that
        // would find the fade and drop it to nothing. That is the flash, the
        // blink and then the slow appearance. So the fade is run once here,
        // before a frame is asked for, which puts everything at zero and starts
        // the clock. The render below is then the first of the fade, not a
        // frame of the finished thing.
        this.startArrivalFade(performance.now());
        if(!this.viewer.isDestroyed?.())this.viewer.scene.requestRender?.();
        this.lastLod=0;this.onEntry?.(false);});
  }
  reset(immediate = false) {
    if(this.transitioning)return;
    this.motion.cancel();this.stopTracking();
    // In 2D the height becomes the map width: the same home view either way.
    const view={destination:this.C.Cartesian3.fromDegrees(HOME_VIEW.longitude,HOME_VIEW.latitude,HOME_VIEW.height),
      orientation:{heading:0,pitch:-Math.PI/2,roll:0},duration:1.3};
    if(immediate)this.viewer.camera.setView(view);else this.viewer.camera.flyTo(view);
  }
  // '2d' is a north-up map, '3d' the globe. Resolves true once this request has
  // settled the scene, false when a newer request superseded it on the way.
  async setSceneMode(mode) {
    if(this.cockpit?.active)this.cockpit.exit();
    const C=this.C,scene=this.viewer.scene,camera=this.viewer.camera;
    const target=mode==='2d'?C.SceneMode.SCENE2D:C.SceneMode.SCENE3D;
    const token=++this.modeToken;this.modeTransition=token;
    const resume=this.tracking || this.approaching?this.selected:null,distance=this.range();
    this.settleApproach();this.stopTracking();
    // A morph still running belongs to a superseded request: finish it where
    // it is and continue from that state instead of fighting it.
    if(scene.mode===C.SceneMode.MORPHING)scene.completeMorph();
    try {
      if(scene.mode!==target){
        if(target===C.SceneMode.SCENE2D){
          // The globe unwraps beneath a vertical camera. Level first, so the
          // morph is a plain top-down unfolding at the scale already on screen
          // rather than a tilted view sliding under a flattening globe.
          await this.levelCamera(distance);
          if(token!==this.modeToken)return false;
        }
        await morphPromise(scene,()=>target===C.SceneMode.SCENE2D?scene.morphTo2D(1.1):scene.morphTo3D(1.1));
        if(token!==this.modeToken)return false;
      }
      const map=scene.mode===C.SceneMode.SCENE2D;
      lockMapControls(scene.screenSpaceCameraController,map);
      if(map){
        // Infinite-scroll 2D ignores view orientation; pin the planar axes north-up.
        camera.lookAtTransform(C.Matrix4.IDENTITY);
        camera.direction=new C.Cartesian3(0,0,-1);camera.up=new C.Cartesian3(0,1,0);camera.right=new C.Cartesian3(1,0,0);
      }
      this.sceneMode=map?'2d':'3d';this.lastLod=0;this.entityScene.lodScan=null;this.surface.anchor=null;
      const target2=resume!==null && this.selected===resume?this.items.get(resume):null;
      if(target2){
        // The pursuit survives the mode change, re-anchored at the scale on screen.
        this.entityScene.refreshPosition(target2,this.motion.now());
        camera.lookAt(target2.position,map?mapOffset(this.range(),this.scratch):offsetFromHeadingPitchRange(0,-Math.PI/2,Math.max(20,this.viewHeight()),this.scratch));
        this.tracking=true;
      }
      this.onMode(this.sceneMode);
      return true;
    } finally {if(token===this.modeToken)this.modeTransition=null;}
  }
  // Fly to a north-up, top-down view of the ground under the screen centre at
  // the current distance. Resolves when the flight ends or is cancelled.
  levelCamera(distance) {
    const C=this.C,v=this.viewer,camera=v.camera;
    this.center.x=v.canvas.clientWidth/2;this.center.y=v.canvas.clientHeight/2;
    const ground=pickGround(camera,v.scene,this.center,this.scratch);
    const carto=ground?C.Cartographic.fromCartesian(ground,C.Ellipsoid.WGS84,this.cartographicScratch ??= new C.Cartographic()):camera.positionCartographic;
    const levelled=Math.abs(camera.pitch+Math.PI/2)<.02;
    if(!carto || levelled)return Promise.resolve();
    const destination=C.Cartesian3.fromRadians(carto.longitude,carto.latitude,(ground?carto.height:0)+Math.max(20,distance));
    return new Promise(resolve=>camera.flyTo({destination,orientation:{heading:0,pitch:-Math.PI/2,roll:0},
      duration:Math.min(1.2,.5+distance/2e6),easingFunction:C.EasingFunction?.QUADRATIC_IN_OUT,complete:resolve,cancel:resolve}));
  }
  // How long a fade started right now should take. The arrival is slower than
  // an ordinary distance fade because a whole network appears at once.
  fadeLength(now) {return now<(this.arrivalFadeUntil ?? 0)?ARRIVAL_FADE_MS:LABEL_FADE_MS;}
  setPerformanceOptions(options) {
    const p=this.performanceOptions=performanceProfile(options),budgets=layerBudgets(p),v=this.viewer;
    v.targetFrameRate=p.targetFps>=60?undefined:p.targetFps;
    this.renderBudget?.configure({minimumScale:p.motionFloor,targetFps:p.targetFps});
    this.entityScene?.setPerformanceOptions(budgets.entities);
    this.vworldBuildings?.setStreamingBudget(budgets.buildings);
    this.vertiportLayer?.setPerformanceOptions(budgets.vertiports);
    if(v.scene.globe)v.scene.globe.tileCacheSize=p.terrainCache;
    if(this.detail&&this.detail.base!==p.terrainError){this.detail.base=p.terrainError;this.detail.error=p.terrainError;this.detail.congestedSince=null;this.detail.idleSince=null;}
    if(v.scene.fog){v.scene.fog.enabled=p.fog>0;v.scene.fog.density=.0006*p.fog;v.scene.fog.screenSpaceErrorFactor=4;}
    this.lastLod=0;this.lastAnnotation=-Infinity;v.scene.requestRender();
    return p;
  }
  performanceSummary() {
    const models=this.entityScene?.modelStats?.();
    return {...this.timing.summary(),models:models?.readyModels??this.entityScene?.stats?.models??0,modelBudget:models,
      buildings:this.vworldBuildings?.stats,hybridBuildings:this.hybridBuildings?.stats,environment:this.environmentView,profile:this.performanceOptions};
  }
  // The infrastructure's presentation, brought up to date at `now`. Called every
  // frame, and once by hand at the arrival so that nothing is ever drawn at full
  // strength before its fade has begun.
  paintInfrastructureFade(now) {
    const v=this.viewer;
    if(v.isDestroyed?.())return;
    // Static annotation appearance is independent of aircraft interpolation.
    // One bounded update avoids traversing every deck's furniture at display Hz.
    const interval=1000/(this.performanceOptions?.annotationHz??60);
    if(now-(this.lastAnnotation??-Infinity)<interval)return;
    const fadeMs=this.fadeLength(now);
    const enabled=!this.entryActive;
    // Nothing here changes on its own: every alpha follows the camera distance
    // and the fade clock, and the entities follow their layers. While the
    // camera is still, the layers are as they were and no fade is running, the
    // pass has nothing to write and is skipped; a walk over a thousand
    // entities thirty times a second was a steady cost even on an idle map.
    const camera=v.camera,p=camera?.positionWC,d=camera?.directionWC;
    const stamp=`${p?.x},${p?.y},${p?.z},${d?.x},${d?.y},${d?.z},${enabled},${this.routeLayer?.visible},${this.vertiportLayer?.visible},`
      +`${this.flightLayer?.visible},${this.flightLayer?.sample?.time_s},${this.routeLayer?.revision},${this.vertiportLayer?.revision},${fadeMs}`;
    // An arrival or an entry resets the clock to -Infinity: that is a pass
    // asked for by name, whatever the stamp says.
    const changed=stamp!==this.annotationStamp || this.lastAnnotation===-Infinity;
    if(!changed && now>=(this.annotationActiveUntil??0))return;
    this.lastAnnotation=now;this.annotationStamp=stamp;
    this.infrastructureLabelFade??=new InfrastructureLabelFade(this.C);
    const started=()=>(this.infrastructureLabelFade?.started??0)+(this.routeGeometryFade?.started??0);
    const before=started();
    if(this.routeLayer?.owned)this.infrastructureLabelFade.update(this.routeLayer.owned,v,now,enabled&&this.routeLayer.visible,0,fadeMs);
    if(this.vertiportLayer?.owned)for(const entities of this.vertiportLayer.owned.values())
      this.infrastructureLabelFade.update(entities,v,now,enabled&&this.vertiportLayer.visible,0,fadeMs,true);
    if(this.flightLayer?.vehicle?.marker)this.infrastructureLabelFade.update(
      [this.flightLayer.vehicle.marker],v,now,this.flightLayer.visible,0,fadeMs);
    if(this.routeLayer?.owned){
      this.routeGeometryFade??=new RouteGeometryFade(this.C);
      this.routeGeometryFade.update(this.routeLayer,v,now,fadeMs,enabled,false);
    }
    // A fade that began keeps the pass running for one fade length, so it
    // finishes; a change with no fade behind it needed only this one pass.
    if(started()!==before)this.annotationActiveUntil=now+fadeMs;
  }
  // The camera has landed: open the slow window and put everything at zero.
  startArrivalFade(now=performance.now()) {
    this.arrivalFadeUntil=now+ARRIVAL_FADE_MS;
    this.lastAnnotation=-Infinity;
    this.paintInfrastructureFade(now);
  }
  frame() {
    const C=this.C,v=this.viewer,now=performance.now();
    if(globalThis.document?.hidden)return;
    this.keyboard?.update(now);
    this.timing.record(now);
    const scale=this.renderBudget?.update(v.camera,{now,frameMs:this.timing.recentMs??this.timing.summary().p50Ms,
      relative:Boolean(this.tracking||this.flightAnchor||this.cockpit?.active),approaching:Boolean(this.approach||this.entryActive),
      viewPose:this.cockpit?.active?cockpitBudgetPose(v.camera):null,
      // The cockpit keeps its pixels: this display is main-thread bound, so
      // the cut bought nothing, and each step of the ladder reallocated every
      // framebuffer -- a hitch on the way down and six coming back, per turn.
      holdResolution:Boolean(this.cockpit?.active),
      enabled:!this.transitioning&&!this.recorder});
    const moving=this.renderBudget?.moving===true;
    // The grade the display was given on the first, empty view, checked against
    // the frames it is actually delivering now that there is a city on it.
    if(this.displayResolution)this.displayResolution.observe({...this.timing.summary?.(),now});
    if(this.displayResolution)this.displayResolution.applyMotion(scale??1);
    else if(Number.isFinite(scale)&&v.resolutionScale!==scale)v.resolutionScale=scale;
    // The arrival owns the camera. Do not scan thousands of live points, initiate
    // live GLB/building loads, pick objects, or terrain-clamp this camera path.
    // Data ingestion continues; the latest samples are displayed on handover.
    if(this.entryActive){
      // Do not refine every intermediate terrain level during the globe-to-city
      // flight. Normal adaptive detail resumes once the camera has arrived.
      if(v.scene?.globe)v.scene.globe.maximumScreenSpaceError=Math.max(this.detail?.value??2,8);
      return;
    }
    // Camera.changed can restyle mesh attributes after the tick. Unlike Entity
    // properties these GPU attributes are consumed by this same render.
    this.routeGeometryFade?.updateMeshes(this.routeLayer,v,now,this.fadeLength(now));
    if(this.placeLabels?.update(now))v.scene.requestRender?.();
    this.entityScene.updateLabelFades?.(now);
    this.entityScene.updatePositions(now);
    // Before the cockpit is posed, so a turn of the head is in this frame
    // rather than the next one.
    this.stepLook(now);
    this.cockpit?.update(now);
    const cadence=this.timing.summary();
    this.cockpitEnvironment?.update(Boolean(this.cockpit?.active)&&!this.is2D(),{
      economy:this.performanceOptions?.preset==='fleet'||
        (cadence.samples>=20&&cadence.p50Ms>Math.max(40,1500/(this.performanceOptions?.targetFps??60)))
    });
    const modelsMoving=moving||Boolean(this.destinationPreparation?.active&&this.destinationPreparation.active.arrivedAt===null);
    this.entityScene.modelsMoving=modelsMoving;
    this.destinationPreparation?.update();
    this.trackGroundPick();
    // How often the cursor is worth reporting is the editor's business: naming a
    // place is a request and wants the quarter second, carrying a waypoint is a
    // transform and wants every frame.
    if(this.routeEditor?.onMove && this.hoverPointer && now-(this.lastRouteMove || 0)>=(this.routeEditor.moveInterval ?? 250)){
      this.lastRouteMove=now;
      const ground=this.groundAt(this.hoverPointer);
      if(ground)this.routeEditor.onMove(ground);
    }
    // Hover picking reads back the GPU. Do not stall an orbit/approach just to
    // discover what happens to pass under a stationary pointer. Click handlers
    // and armed editors remain immediate; hover resumes when movement settles.
    const deferHover=this.cockpit?.active || moving&&!this.routeEditor&&!this.vertiportEditor&&!this.groundPick;
    if(deferHover){
      if(!this.hoverDeferred){
        this.entityScene.setHovered(null);this.routeLayer?.hover(null);this.vertiportLayer?.setHovered(null);
        this.hoverAirspace=null;this.hoverFlight=false;v.canvas.style.cursor='';this.onHover(null,this.hoverPointer,null);
      }
      this.hoverDirty=Boolean(this.hoverPointer);
    }
    this.hoverDeferred=deferHover;
    // A pick renders the scene again and reads the GPU back. A pointer that
    // moved is answered at once; a pointer that stays where it is, over
    // something already lit, is asked again only a few times a second, since
    // all that can change under it is the object itself moving on.
    const hovering=()=>Boolean(this.entityScene?.hoveredId || this.routeLayer?.hovered || this.vertiportLayer?.hovered || this.hoverAirspace || this.hoverFlight);
    const sinceHoverPick=now-(this.lastHoverPick || 0);
    const hoverDue=()=>this.hoverDirty?sinceHoverPick>=HOVER_PICK_MS:hovering()&&sinceHoverPick>=(moving?HOVER_PICK_MS*2:HOVER_RECHECK_MS);
    if(!deferHover && this.hoverPointer && hoverDue()) {
      this.lastHoverPick=now;this.hoverDirty=false;
      const topPick=v.scene.pick(this.hoverPointer,PICK_SLACK_PX,PICK_SLACK_PX);
      const surfacePick=pickThroughAirspace(v.scene,this.hoverPointer,topPick??null)??null;
      // Hover stays on the visible deck under the pointer. The enlarged UAM
      // click target must not steal a nearby facility's hover.
      const directPort=this.vertiportLayer.pick?.(surfacePick);
      const picked=directPort?surfacePick:this.pickInteraction(this.hoverPointer,surfacePick);
      const id=this.pickEntity(this.hoverPointer,picked,true);this.entityScene.setHovered(id);
      const flightHit=this.flightLayer?.pick(picked);
      this.hoverFlight=Boolean(flightHit);
      // With an editor armed the pointer also lights up what it can act on:
      // route waypoints and links, or a vertiport. These precede airspace info.
      const editing=this.routeEditor || this.vertiportEditor;
      const routeHit=this.routeEditor?this.routeLayer.pick(picked):null;
      const portHoverAllowed=Boolean(this.vertiportEditor)||(!this.routeEditor&&!this.demandEditor&&!this.groundPick&&!this.scrap);
      const vertiportHit=portHoverAllowed&&!id&&!flightHit?this.vertiportLayer.pick?.(picked):null;
      if(this.routeLayer.hover(routeHit))v.scene.requestRender();
      if(this.vertiportLayer.setHovered(vertiportHit?.id ?? null))v.scene.requestRender();
      this.hoverAirspace=!picked && !editing && !this.groundPick?airspaceBoundaryOf(topPick):null;
      this.viewer.canvas.style.cursor=this.groundPick || this.routeEditor?.crosshair?'crosshair':(id || flightHit || routeHit || vertiportHit?'pointer':this.hoverAirspace?'help':'');
      this.onHover(id?this.items.get(id).entity:null,this.hoverPointer,this.hoverAirspace);
    }
    // Cesium owns the camera while the scene morphs: the objects keep moving,
    // but nothing here may steer, clamp or re-scan until the mode settles.
    if(this.transitioning)return;
    const centred=this.tracking?this.items.get(this.selected):null;
    if(!this.cockpit?.active && !this.stepApproach(now,{maxStep:50}) && centred){
      // Re-anchoring every frame keeps the operator's orbit while the object
      // moves. On the map the anchor is the current width, not a position.
      this.entityScene.refreshPosition(centred,now);
      const camera=v.camera;
      const offset=this.is2D()?mapOffset(camera.frustum.right-camera.frustum.left,this.scratch):C.Cartesian3.clone(camera.position,this.scratch);
      const anchor=this.is2D()?centred.position:this.springTarget(centred.position,this.selected,now,C.Cartesian3.magnitude(offset));
      camera.lookAt(anchor,offset);
    }
    // The deck lamps burn a little brighter and dimmer as the seconds pass and
    // the beacons flash. Stepped a few times a second rather than every frame:
    // the eye cannot tell, and a field of lamps is thousands of points.
    if(now-(this.lastLamp ?? 0)>=45){this.lastLamp=now;this.vertiportLayer?.tickLights?.(now/1000);}
    // The scene renders continuously today, so this asks for nothing it would
    // not already get. It is here for the day it does not: a fade is the one
    // thing on screen that changes while the camera is still, and under
    // requestRenderMode it would otherwise stop half way up and stay there.
    if(now<(this.arrivalFadeUntil ?? 0))v.scene.requestRender?.();
    if(!this.cockpit?.active&&!centred&&this.followedFlightSample)this.followFlight(this.followedFlightSample,{now});
    if(!this.cockpit?.active&&this.motion.active){const range=this.range();v.camera.moveForward(range-this.motion.advance(range));}
    if(!this.cockpit?.active)this.keepAboveGround();
    // Terrain detail: the adaptive level, or the approach's coarser middle.
    if(v.scene.globe && this.detail){
      if(now-(this.lastDetail ?? 0)>=200){this.lastDetail=now;this.detail.observe(this.pendingTiles ?? 0,this.viewHeight(),now);}
      // Not in the cockpit: a pilot turns all the time, and coarsening the
      // ground for each turn meant re-refining it after each turn -- a burst
      // of tile loads and a visible drop in detail, for every look around.
      v.scene.globe.maximumScreenSpaceError=Math.max(this.detail.value,this.approachDetail ?? 0,moving&&!this.cockpit?.active?(scale<1?6:4):0);
    }
    if(this.entityScene.needsLod || this.entityScene.lodScan || now-this.lastLod>=(moving?250:200)){
      this.entityScene.retirePreparation?.(now);
      if(!this.entityScene.lodScan)this.lastLod=now;
      this.entityScene.updateLod(this.selected,now,{incremental:true,moving:modelsMoving,tracking:Boolean(this.tracking || this.approaching)});
    }
    // A predicted path is overtaken while it is watched, so it follows the
    // aircraft every frame; asking the server for a new one stays on its own
    // bounded schedule independently of the surface work.
    if(this.trajectory.follow())v.scene.requestRender();
    // The prediction layer owns its 200 ms / single-in-flight limiter. Do not
    // quantize it again through the unrelated terrain/imagery surface timer.
    void this.trajectory.update(now);
    // Somebody walking to an aircraft is the same kind of thing: they move
    // every frame, and asking the server who is walking stays on its own slower
    // schedule inside the layer. Five updates a second is a walk in stop
    // motion, and on a deck the camera is close to that is all anyone sees.
    if(this.scenarioPassengers?.update())v.scene.requestRender();
    const passengers=this.scenarioPassengers;
    this.entityScene.updateManualGround(passengers?.shown!==false);
    if(passengers?.shown){
      const carry=passengers.carriedSeconds();
      // The indexes are rebuilt when the layer has new answers, not every
      // frame: between fetches the same walks and cabins index the same way.
      const index=this.passengerIndex;
      if(!index||index.walks!==passengers.walks||index.cabins!==passengers.cabins||index.withCabins!==(carry!==null)){
        this.passengerIndex={walks:passengers.walks,cabins:passengers.cabins,withCabins:carry!==null,
          walks_by:new Map(passengers.walks.map(w=>[w.aircraft_id,w])),
          cabins_by:new Map((carry===null?[]:passengers.cabins??[]).map(c=>[c.aircraft_id,c]))};
      }
      const walks=this.passengerIndex.walks_by,cabins=this.passengerIndex.cabins_by;
      for(const [id,item] of this.items){
        if(this.entityScene.manualSample(item))continue;
        // Seats and doors are nodes of a loaded model. An aircraft drawn as a
        // point has nothing to show them on, and both calls below would
        // return at once, so its cabin state is not worked out at all.
        if(!item.model?.ready)continue;
        const key=item.passengerKey??=id.replace(/^(scenario|physical):/,'');
        const profile=this.entityScene.assets.get(item.assetId)?.cockpit;
        const state=cabinAt(cabins.get(key),carry===null?null:walks.get(key),carry??0);
        const ownSeat=this.cockpit?.active&&this.cockpit.model===item.model?profile?.viewpoints?.find(p=>p.id===this.cockpit.camera.viewpoint)?.occupant_node:null;
        showCabin(this.C,item.model,profile,state.seats,{ownSeat,preview:this.cockpit?.active&&this.cockpit.model===item.model&&this.cockpit.panel.occupantsShown});
        showDoors(this.C,item.model,profile,state);
      }
    }
    if(this.flightTrack?.update())v.scene.requestRender();
    if(now-this.lastSurface<200)return;this.lastSurface=now;
    const height=this.viewHeight();
    this.terrain?.update(now);this.terrain?.setTilesLoading(!v.scene.globe.tilesLoaded);
    // A distant terrain/imagery request must not blank an entire city's models.
    // Fixed-height tiles use the provider; footprints wait for their OWN sample.
    const surfaceReady=Boolean(this.terrain?.ready && !this.terrainFlat);
    this.buildings.setSurfaceReady(surfaceReady);
    const buildingHeight=this.is2D()?Infinity:height;
    this.buildings.update(buildingHeight,now);
    const view=this.viewRectangle();
    // Flat ground needs no terrain to stand on; otherwise the same gate as OSM.
    this.vworldBuildings?.setSurfaceReady(this.terrainFlat || !this.terrain || surfaceReady);
    const environment=this.environmentView=this.cameraEnvironment.update({height,
      range:this.range(),following:Boolean(this.tracking||this.approaching||this.flightAnchor),
      fog:this.performanceOptions?.fog??1,maximum:buildingRange(this.buildingAppearance.distance,height)},now);
    if(v.scene.fog){
      v.scene.fog.density=environment.density;v.scene.fog.visualDensityScalar=environment.visualDensity;
      v.scene.fog.screenSpaceErrorFactor=environment.fogError;
    }
    const buildingView=this.buildingsEnabled&&buildingHeight<BUILDING_FAR_HEIGHT?this.buildingViewCache?.read(v,{...this.buildingAppearance,height,environment},now):null;
    this.hybridBuildings?.update({view:buildingView,distance:this.performanceOptions?.hybridDistance??1500});
    const focusedModel=this.items.get(this.selected);
    const focusPending=now<(this.focusPriorityUntil??0)&&Boolean(focusedModel?.loading||focusedModel?.model?.ready===false);
    this.vworldBuildings?.update(buildingHeight,view,now,buildingView,{moving,focusPending});
    this.vworld3d?.setSurfaceReady(surfaceReady);
    this.vworld3d?.update(buildingHeight,now);
    // A tileset appears long after the vertiports do, so the ground they cover
    // is applied again whenever one turns up.
    if(this.clippedGround?.length)this.clipTilesets(this.clippedGround);
    // Median ignores isolated shader-compilation/browser-occlusion pauses;
    // sustained GPU load still relaxes the near-field detail gradually.
    const frameMs=this.timing.summary().p50Ms;
    const targetFps=this.performanceOptions?.targetFps??60;
    // The same for the city: its detail is held through a cockpit's turns.
    const turning=moving&&!this.cockpit?.active;
    if(this.buildings.tileset?.show)this.osmBuildingFocus?.update(v.camera,{height,frameMs,now,view:buildingView,moving:turning,targetFps});
    if(this.vworld3d?.tileset?.show)this.vworld3dFocus?.update(v.camera,{height,frameMs,now,view:buildingView,moving:turning,targetFps});
    this.onView(view);
  }
  // The visible ground rectangle in degrees, or null when the camera is not
  // looking at the globe. Display geometry only: the caller decides whether it
  // is worth telling anyone, and nothing here changes what is drawn.
  viewRectangle() {
    // Once per surface pass, so the engine's own result object is cheap enough.
    const C=this.C,rectangle=this.viewer.camera.computeViewRectangle(C.Ellipsoid.WGS84);
    if(!rectangle)return null;
    const degrees=C.Math.toDegrees;
    const window={lamin:degrees(rectangle.south),lamax:degrees(rectangle.north),
      lomin:degrees(rectangle.west),lomax:degrees(rectangle.east)};
    // A rectangle that crosses the antimeridian arrives with west > east.
    return Object.values(window).every(Number.isFinite) && window.lamin<window.lamax && window.lomin<window.lomax?window:null;
  }
  keyboardAvailable() {
    return !this.cockpit?.active && !this.selected && !this.detailId && !this.tracking && !this.approaching && !this.flightAnchor &&
      !this.entryActive && !this.transitioning && !this.groundPick && !this.routeEditor && !this.vertiportEditor && !this.demandEditor && !this.scrap && !this.recorder &&
      !this.is2D() && this.destinationPreparation?.active?.arrivedAt!==null &&
      this.viewer.scene.screenSpaceCameraController.enableInputs!==false;
  }
  moveKeyboard({forward,right,up,yaw}) {
    const C=this.C,c=this.viewer.camera,heading=c.heading;
    this.motion.cancel();c.cancelFlight();c.lookAtTransform(C.Matrix4.IDENTITY);
    const local=this.keyboardLocal ??= new C.Cartesian3(),world=this.keyboardVector ??= new C.Cartesian3();
    // Ground-plane movement remains useful even when looking straight down.
    // Z/X use geodetic up, not the screen's up vector.
    local.x=Math.sin(heading)*forward+Math.cos(heading)*right;
    local.y=Math.cos(heading)*forward-Math.sin(heading)*right;local.z=up;
    const frame=C.Transforms.eastNorthUpToFixedFrame(c.positionWC,undefined,this.keyboardFrame ??= new C.Matrix4());
    C.Matrix4.multiplyByPointAsVector(frame,local,world);
    const distance=C.Cartesian3.magnitude(world);
    if(distance>0)c.move(C.Cartesian3.normalize(world,world),distance);
    if(yaw)c.setView({orientation:{heading:heading+yaw,pitch:c.pitch,roll:c.roll}});
    this.viewer.scene.requestRender();
  }
  keepAboveGround() {
    // The map has no relief to collide with; an approach sets the pose itself.
    if(this.is2D() || this.approach)return;
    const v=this.viewer,c=v.camera,p=c.positionCartographic;
    if(p.height>30000)return;
    const height=clearanceHeight(p.height,v.scene.globe.getHeight(p));
    if(height<=p.height+.01)return;
    // Whatever the camera is orbiting: a tracked object, or a flight it is
    // riding with. Rising inside that frame keeps the orbit centre and the
    // operator's direction through a terrain clamp. Releasing the camera here
    // instead would hand it back a frame before the follow grabbed it again,
    // and the two would fight each other into a shake — which is exactly what
    // happens on the way in, when the camera comes low enough to be clamped.
    const centred=this.tracking?this.items.get(this.selected):null;
    const anchor=centred?(this.trackingAnchor??centred.position):this.flightAnchor;
    if(anchor){
      const offset=this.C.Cartesian3.clone(c.position,this.scratch);
      offset.z+=height-p.height;
      this.motion.cancel();c.lookAt(anchor,offset);
      return;
    }
    const destination=this.C.Cartesian3.fromRadians(p.longitude,p.latitude,height);
    const orientation={heading:c.heading,pitch:c.pitch,roll:c.roll};
    this.motion.cancel();this.stopTracking();c.setView({destination,orientation});
  }
  showVertiports(records) {
    this.portsReady=this.vertiportLayer.show(records);
    // The list comes round again on every revision poll and after every save.
    // The route network stands on the decks, so it is resampled and redrawn
    // only when a deck was actually placed, changed or taken away; an
    // unchanged list is a comparison and nothing more.
    const changed=this.vertiportLayer.showChanged!==0;
    return this.portsReady
      .then(()=>{this.clearGroundUnderVertiports(records);return changed?this.routeLayer.refresh():undefined;})
      .then(()=>this.viewer.scene.requestRender());
  }
  // A vertiport built on top of an existing building leaves that building
  // standing through the deck and out around it, which reads as two buildings
  // in one place. The ground each deck covers is handed to the building layers
  // so they leave it alone: the extruded cells skip a building whose footprint
  // is under one, and a streamed tileset is clipped to the same outlines.
  // Nothing is destroyed — removing a vertiport gives its building back.
  //
  // Two outlines, because the two jobs want different ones. Clipping a streamed
  // tileset pushes out a few metres so the host building's wall does not show a
  // sliver beside the cladding. Deciding whether to drop a whole extruded
  // building must not: a neighbour that merely stands within those few metres
  // is a real building and stays, while one whose footprint runs into the deck
  // itself is inside the vertiport and goes.
  clearGroundUnderVertiports(records) {
    const layouts = (records ?? []).map(record => record?.layout).filter(Boolean);
    const cleared = footprintsOf(layouts, 0);
    // Kept, because the building-conflict check has to be told the same thing:
    // a route is not in danger from a building that is no longer there.
    const signature = cleared.map(ring => ring.map(p => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';')).join('|');
    const moved = this.clearedGroundSignature !== undefined && this.clearedGroundSignature !== signature;
    this.clearedGround = cleared;
    this.clearedGroundSignature = signature;
    this.vworldBuildings?.setCleared?.(cleared, overlapsFootprint);
    this.clipTilesets(footprintsOf(layouts));
    // A deck that moved changed which buildings are under which route. Every
    // report measured against the old city is now an answer to a question
    // nobody asked, so it goes rather than lingering as a stale warning.
    if (moved) {this.routeLayer?.clearConflicts?.(); this.onClearedGround?.();}
  }
  clipTilesets(rings) {
    const C = this.C;
    if (!C.ClippingPolygonCollection || !C.ClippingPolygon) return;
    // A tileset arrives later than the vertiports do, so the outlines are kept
    // and applied again whenever one appears.
    this.clippedGround = rings;
    for (const tileset of [this.buildings?.tileset, this.vworld3d?.tileset]) {
      if (!tileset || !('clippingPolygons' in tileset)) continue;
      // A tileset that already carries these outlines is left alone: rebuilding
      // the collection every surface pass would drop its tiles each time.
      if (tileset.aerodtClippedRings === rings.length) continue;
      tileset.aerodtClippedRings = rings.length;
      if (!rings.length) {tileset.clippingPolygons = undefined; continue;}
      tileset.clippingPolygons = new C.ClippingPolygonCollection({
        // Inside a deck's outline the tileset is cut away; everywhere else it
        // is untouched.
        polygons: rings.map(ring => new C.ClippingPolygon({
          positions: ring.map(point => C.Cartesian3.fromDegrees(point.longitude, point.latitude))})),
      });
    }
  }
  // A network arriving before the camera has ever moved still needs its scale.
  async showRoutes(network,segments) {
    // Initial route data can arrive while decks are still resolving. Drawing
    // it twice (before and after deck heights) restarts the whole reveal.
    const request=this.routeRequest=(this.routeRequest??0)+1;
    await this.portsReady;
    if(request!==this.routeRequest || this.viewer.isDestroyed?.())return;
    await this.routeLayer.show(network,segments);
    this.updateGroundScale();this.viewer.scene.requestRender();
  }
  // Airspace: the zones to draw, and whether they are drawn at all.
  showAirspace(collection) {const count=this.airspaceLayer.show(collection);this.updateGroundScale();this.viewer.scene.requestRender();return count;}
  setAirspaceEnabled(enabled) {if(this.airspaceLayer.setEnabled(enabled)){this.clearHover();this.updateGroundScale();this.viewer.scene.requestRender();}}
  // A flight plan on the map, and the aircraft moved to one second of it.
  showFlightPlan(plan) {if(this.cockpit?.single)this.cockpit.exit();const count=this.flightLayer.show(plan);this.viewer.scene.requestRender();return count;}
  // The top of a placed vertiport's deck, so a flight plan's heights can be
  // resolved against the same platform the route's FATO endpoints stand on.
  deckTopOf(id) {return this.vertiportLayer.deckTop(id);}
  moveFlight(sample) {
    if(this.flightLayer.moveTo(sample)){
      // An external camera follows the newest immutable snapshot, not the
      // snapshot held when the operator left the cockpit.
      if(this.followedFlightSample)this.followedFlightSample=sample;
      this.viewer.scene.requestRender();
    }
  }
  // Go to the aircraft and stay with it, the way selecting a live one does:
  // behind it, looking down its path, close enough to read the airframe.
  //
  // The camera takes the aircraft's frame straight away and only the distance
  // is eased in, using the same range motion every other approach here uses.
  // Flying the camera to a bounding sphere instead would be cancelled by the
  // first frame of following — the two ran together and the approach ended in
  // a snap rather than an arrival.
  // The same framing flyToFlight picks, reached over a fixed stretch of time
  // rather than as fast as the range motion can travel. Entering manual flight
  // from a city-wide view, that motion covered twenty kilometres in about a
  // third of a second: the camera read as being yanked into the aircraft rather
  // than flown to it. Resolves when the approach has arrived, so whatever comes
  // next -- the cockpit -- does not cut across it.
  flyToFlightSmoothly(sample,{seconds}={}) {
    if(!sample?.position)return Promise.resolve(false);
    const C=this.C,at=sample.position,camera=this.viewer.camera;
    const target=C.Cartesian3.fromDegrees(at.longitude,at.latitude,at.altitude_m);
    const distance=C.Cartesian3.distance(camera.positionWC,target);
    // Near enough already: a glide would be a pause with nothing to watch.
    if(!(distance>FLIGHT_VIEW_RANGE_M*2))return Promise.resolve(false);
    if(this.cockpit?.active)this.cockpit.exit();
    this.cameraSpring?.reset();this.trackingAnchor=null;this.springStateTime=undefined;this.followedFlightSample=null;
    this.destinationPreparation?.cancel();
    this.motion.cancel();camera.cancelFlight();
    // Measured against the old path from 14 km out: that one was inside 400 m in
    // 1.25 s at a peak of 9.5 e-folds a second. These numbers put the same
    // approach around 2.7 s and nearer 6, which is a glide rather than a pull.
    const travel=Number.isFinite(seconds)?seconds
      :Math.min(3.4,Math.max(1.4,1.1+distance/9000));
    return new Promise(resolve=>{
      camera.flyToBoundingSphere(new C.BoundingSphere(target,1),{
        duration:travel,
        offset:new C.HeadingPitchRange(C.Math.toRadians(sample.heading_deg||0),
          C.Math.toRadians(-28),FLIGHT_VIEW_RANGE_M),
        easingFunction:C.EasingFunction?.QUADRATIC_IN_OUT,
        complete:()=>resolve(true),cancel:()=>resolve(false)});
    });
  }
  flyToFlight(sample) {
    if(this.cockpit?.active)this.cockpit.exit();
    this.cameraSpring?.reset();this.trackingAnchor=null;this.springStateTime=undefined;this.followedFlightSample=null;
    this.destinationPreparation?.cancel();
    if(!sample?.position)return;
    const C=this.C,at=sample.position,camera=this.viewer.camera;
    const target=C.Cartesian3.fromDegrees(at.longitude,at.latitude,at.altitude_m);
    const from=Math.max(FLIGHT_VIEW_RANGE_M,C.Cartesian3.distance(camera.positionWC,target));
    this.motion.cancel();camera.cancelFlight();
    camera.lookAt(target,offsetFromHeadingPitchRange(C.Math.toRadians(sample.heading_deg||0),
      C.Math.toRadians(-28),from,this.scratch));
    this.flightAnchor=C.Cartesian3.clone(target,this.flightAnchor ?? new C.Cartesian3());
    if(from>FLIGHT_VIEW_RANGE_M+1)this.motion.moveTo(from,FLIGHT_VIEW_RANGE_M);
    this.viewer.scene.requestRender();
  }
  // The camera rides with it on an arm the operator owns, the same way it rides
  // with a tracked aircraft: only the anchor moves each frame, so a drag, a
  // tilt and a wheel notch all survive the aircraft moving under them.
  //
  // Writing a heading, a pitch and a range every frame instead would undo every
  // one of those on the next frame — the view could not be turned at all — and
  // would swing the whole world with the airframe's own yaw, which a flown
  // aircraft never holds perfectly still.
  followFlight(sample,{reset=false,now=performance.now()}={}) {
    if(this.cockpit?.active){this.followedFlightSample=sample;return;}
    if(!sample?.position)return;
    if(reset)this.cameraSpring?.reset();
    this.followedFlightSample=sample;
    const C=this.C,at=sample.position,camera=this.viewer.camera;
    const target=C.Cartesian3.fromDegrees(at.longitude,at.latitude,at.altitude_m);
    // `camera.position` is only an offset while the camera is inside a frame.
    // With no frame set — before the first follow, or straight after a flight
    // to the aircraft — it is a position on the globe, and reusing it as an
    // offset would throw the camera halfway across the world.
    const riding=this.flightAnchor && !C.Matrix4.equals(camera.transform,C.Matrix4.IDENTITY);
    const offset=riding
      ?C.Cartesian3.clone(camera.position,this.scratch)   // where the operator is standing
      :offsetFromHeadingPitchRange(C.Math.toRadians(sample.heading_deg||0),
        C.Math.toRadians(-28),FLIGHT_VIEW_RANGE_M,this.scratch);
    const anchor=this.springTarget(target,'single-flight',now,C.Cartesian3.magnitude(offset),sample.time_s);
    this.flightAnchor=C.Cartesian3.clone(anchor,this.flightAnchor ?? new C.Cartesian3());
    camera.lookAt(anchor,offset);
    this.viewer.scene.requestRender();
  }
  // A hand controller's head switch moves the view, not the aircraft. Inside
  // the cockpit that is the pilot turning their head; outside it is the same
  // orbit a mouse drag gives. Both survive the aircraft moving underneath,
  // because `followFlight` re-anchors without touching the operator's offset.
  lookAround(dx,dy,dt=1/60) {
    if(!Number.isFinite(dx)||!Number.isFinite(dy)||(!dx&&!dy))return false;
    const step=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:1/60));
    if(this.cockpit?.active){this.cockpit.look(dx*step*520,dy*step*520);this.viewer?.scene?.requestRender?.();return true;}
    const camera=this.viewer?.camera,C=this.C;
    if(!camera||(!this.flightAnchor&&!this.tracking))return false;
    // Only orbits while the camera sits in a frame around something. Free of
    // one, `camera.position` is a place on the globe and rotating about it
    // would throw the view across the world.
    if(C?.Matrix4&&camera.transform&&C.Matrix4.equals(camera.transform,C.Matrix4.IDENTITY))return false;
    const rate=step*1.05;
    if(dx)camera.rotateRight?.(dx*rate);
    if(dy){
      camera.rotateUp?.(dy*rate);
      // Stop short of straight overhead. Past it the orbit rolls over, the
      // horizon inverts, and it is hard to recover with a four-way switch.
      const at=camera.position,length=at&&C?.Cartesian3?C.Cartesian3.magnitude(at):0;
      if(length>0&&Math.abs(at.z/length)>.985)camera.rotateUp?.(-dy*rate);
    }
    this.viewer.scene?.requestRender?.();
    return true;
  }
  // A head switch is held, not nudged. What arrives here is which way it is
  // being pushed; how far the view has turned by now is settled on the render
  // loop, in `stepLook`. It used to be settled on the flight command's own tick
  // instead -- twenty a second against a screen drawing sixty -- so two frames
  // in three got nothing and the third jumped three degrees. That is the
  // stepping that was reported, and it is a sampling rate, not a speed.
  setLook(x,y,speed=1,zoom=0) {
    const unit=v=>Number.isFinite(v)?Math.max(-1,Math.min(1,v)):0;
    const look=this.look??={x:0,y:0,zoom:0,speed:1,dx:0,dy:0,gain:0,stamp:null};
    look.x=unit(x);look.y=unit(y);look.zoom=unit(zoom);
    look.speed=Number.isFinite(speed)?Math.max(.1,Math.min(4,speed)):1;
    // Diagonals are a direction, not a bonus: pushing two ways at once on a
    // four-button switch would otherwise look around 41% faster than one way.
    // The direction is kept after the switch is let go, so the view coasts to a
    // stop along the way it was already going.
    const length=Math.hypot(look.x,look.y);
    if(length){look.dx=look.x/Math.max(1,length);look.dy=look.y/Math.max(1,length);}
    return look;
  }
  // One frame of it. The ramp is the keyboard camera's own, for the same reason
  // and with the same feel: a switch that goes from nothing to everything
  // between two frames starts and stops with a jolt, and a jolt reads as the
  // camera being coarse even when every frame is drawn.
  stepLook(now=performance.now()) {
    const look=this.look;
    if(!look)return false;
    const held=Boolean(look.x||look.y);
    if(!held&&!look.gain&&!look.zoom){look.stamp=null;return false;}
    // Its own clock, because it is driven by whatever frame rate the scene is
    // managing rather than by a fixed tick.
    const dt=look.stamp===null?1/60:Math.max(0,Math.min(.05,(now-look.stamp)/1000));
    look.stamp=now;
    if(!dt)return false;
    look.gain+=((held?1:0)-look.gain)*-Math.expm1(-dt/(held?LOOK_RAMP_S:LOOK_RELEASE_S));
    // A stop has to be a stop; an exponential only approaches one.
    if(!held&&look.gain<.03)look.gain=0;
    let moved=false;
    if(look.gain)moved=this.lookAround(look.dx*look.gain*look.speed,look.dy*look.gain*look.speed,dt)||moved;
    if(look.zoom)moved=this.lookZoom(look.zoom*dt)||moved;
    // The scene renders continuously today. Under requestRenderMode a camera
    // turning by itself is exactly the case that would otherwise stop the loop
    // that is turning it.
    if(moved)this.viewer?.scene?.requestRender?.();
    return moved;
  }
  lookZoom(amount) {
    if(!Number.isFinite(amount)||!amount)return false;
    if(this.cockpit?.active){this.cockpit.zoom(amount*900,0);return true;}
    this.zoom(Math.exp(amount*.9));return true;
  }
  // Back to the framing an arrival gives. Outside the cockpit the frame has to
  // go first: `followFlight` keeps the operator's offset while one is standing,
  // which is the very thing being undone here.
  resetLook() {
    if(this.cockpit?.active){this.cockpit.resetLook();this.viewer?.scene?.requestRender?.();return true;}
    const sample=this.followedFlightSample;
    if(!sample)return false;
    this.viewer?.camera?.lookAtTransform?.(this.C.Matrix4.IDENTITY);
    this.followFlight(sample,{reset:true});
    return true;
  }
  releaseFlight() {
    if(this.cockpit?.single)this.cockpit.exit();
    this.cameraSpring?.reset();this.trackingAnchor=null;this.springStateTime=undefined;this.followedFlightSample=null;
    this.flightAnchor=null;
    this.viewer.camera.lookAtTransform(this.C.Matrix4.IDENTITY);
    this.viewer.scene.requestRender();
  }
  selectRouteNode(id,blocked) {this.routeLayer.select(id,blocked);this.viewer.scene.requestRender();}
  // What the building check needs for each link: where its ends stand as the
  // map placed them, and the terrain along it, so the path's height over every
  // building can be worked out where the buildings are. `ids` limits it to some
  // links; null is the whole network.
  async routeConflictRequest(ids=null,{stepMetres=100,vertiportId=null,heights=null}={}) {
    const layer=this.routeLayer;
    const wanted=new Set(ids ?? []);
    const links=(layer.network?.links ?? []).filter(link=>(!ids || wanted.has(link.id)) && (!vertiportId || [link.from,link.to].some(id=>layer.placed.get(id)?.node.vertiport===vertiportId)) && layer.placed.has(link.from) && layer.placed.has(link.to));
    const samples=[],spans=[];
    for(const link of links){
      const {from,to}=layer.linkEndpoints(link,{vertiportId,heights});
      const count=Math.max(1,Math.ceil(distanceMetres(from,to)/stepMetres));
      const start=samples.length;
      for(let i=0;i<=count;i++){const u=i/count;samples.push({longitude:from.longitude+(to.longitude-from.longitude)*u,latitude:from.latitude+(to.latitude-from.latitude)*u});}
      spans.push([start,samples.length]);
    }
    let grounds=[];
    try {grounds=(await this.groundHeights(samples,{strict:true})) ?? [];} catch {grounds=[];}
    return {cleared:(this.clearedGround ?? []).map(ring=>ring.map(point=>[point.longitude,point.latitude])),
      links:links.map((link,index)=>{
      const {from,to}=layer.linkEndpoints(link,{vertiportId,heights});
      const [start,end]=spans[index];
      const along=grounds.slice(start,end).map(h=>Number.isFinite(h)?h:0);
      return {id:link.id,segment:link.segment,width_m:link.width_m ?? null,
        from:{longitude:from.longitude,latitude:from.latitude,height:from.height,ground:from.ground},
        to:{longitude:to.longitude,latitude:to.latitude,height:to.height,ground:to.ground},
        terrain_available:grounds.slice(start,end).length===end-start && grounds.slice(start,end).every(Number.isFinite),
        grounds:along.length===end-start?along:[from.ground ?? 0,to.ground ?? 0]};
    })};
  }
  previewVertiportHeights(id,heights) {this.routeLayer.previewVertiportHeights(id,heights);this.viewer.scene.requestRender();}
  showVertiportHeightConflicts(reports) {this.routeLayer.setHeightPreviewConflicts(reports);this.viewer.scene.requestRender();}
  // The check's word on some links, drawn: red through a building, amber close over one.
  showRouteConflicts(reports) {this.routeLayer.setConflicts(reports);this.viewer.scene.requestRender();}
  clearRouteConflicts() {this.routeLayer.clearConflicts();this.viewer.scene.requestRender();}
  previewRouteLink(from,to) {if(this.routeLayer.previewLink(from,to))this.viewer.scene.requestRender();}
  routePosition(id) {return this.routeLayer.position(id);}
  // Screen position of a world point, or null when it is off screen or behind the globe.
  screenOf({longitude,latitude,height}) {
    const C=this.C,v=this.viewer,world=C.Cartesian3.fromDegrees(longitude,latitude,height);
    const screen=C.SceneTransforms.worldToWindowCoordinates?.(v.scene,world) ?? C.SceneTransforms.wgs84ToWindowCoordinates?.(v.scene,world);
    return screen && Number.isFinite(screen.x) && Number.isFinite(screen.y)?{x:screen.x,y:screen.y}:null;
  }
  // Explicit operator action: select one saved facility nearest the viewport centre.
  // Projection alone can include the far side of the globe, so test occlusion too.
  vertiportInView(records) {
    const C=this.C,v=this.viewer,width=v.canvas.clientWidth,height=v.canvas.clientHeight;
    if(!width||!height)return null;
    const occluder=v.scene.mode===C.SceneMode.SCENE3D?new C.EllipsoidalOccluder(C.Ellipsoid.WGS84,v.camera.positionWC):null;
    let chosen=null,best=Infinity;
    for(const record of records){const f=record.layout?.frame;if(!f||!Number.isFinite(f.longitude)||!Number.isFinite(f.latitude))continue;
      const world=C.Cartesian3.fromDegrees(f.longitude,f.latitude,f.altitude_m??0);
      if(occluder&&!occluder.isPointVisible(world))continue;
      const p=C.SceneTransforms.worldToWindowCoordinates(v.scene,world);
      if(!p||p.x<0||p.y<0||p.x>width||p.y>height)continue;
      const score=(p.x-width/2)**2+(p.y-height/2)**2;if(score<best){best=score;chosen=record.id;}
    }
    return chosen;
  }
  // While a route editor is set, clicks answer to it (a node, a link or the
  // ground under the cursor) instead of selecting aircraft; null hands them back.
  setRouteEditor(editor) {
    this.routeEditor=editor ?? null;
    this.viewer.canvas.style.cursor=this.routeEditor?.crosshair?'crosshair':'';
  }
  // While a vertiport editor is set, a click or right click on a saved
  // vertiport answers to it instead of selecting an aircraft; null hands the
  // map back and clears the hover.
  setVertiportEditor(editor) {
    this.vertiportEditor=editor ?? null;
    if(!this.vertiportEditor && this.vertiportLayer.setHovered(null))this.viewer.scene.requestRender();
  }
  // A waypoint on the move: the layer draws it faint where it stands and a
  // ghost under the cursor. A null pose puts it back.
  moveRouteNode(id,pose) {if(this.routeLayer.moveNode(id,pose))this.viewer.scene.requestRender();}
  flyToRouteNode(id,range=2500) {
    const place=this.routeLayer.position(id);
    if(!place)return;
    const C=this.C;this.motion.cancel();this.stopTracking();
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(place.longitude,place.latitude,place.height),200),
      {duration:1.4,offset:new C.HeadingPitchRange(this.viewer.camera.heading,-0.75,range)});
  }
  previewVertiport(layout,name) {return this.vertiportLayer.preview(layout,name).then(()=>this.viewer.scene.requestRender());}
  // `settings` is {enabled, source, opacity}; only what is given changes.
  setCloudSettings(settings) {this.clouds.apply(settings);}
  // Whether the selected aircraft is drawn with the path the twin's estimator
  // expects next. Turning it on asks for the current selection at once;
  // turning it off takes the drawn one away.
  setTrajectoryPrediction(enabled) {return this.setPredictionFor('aircraft',enabled);}
  // A UAM's prediction is its own setting: the twin is flying it along a route,
  // so a different set of models applies and the operator turns it on
  // separately from the aircraft one.
  setUamPrediction(enabled,settings=null) {
    const changed=Boolean(settings && (settings.model!==this.uamPredictionSettings?.model ||
      settings.seconds!==this.uamPredictionSettings?.seconds));
    if(settings)this.uamPredictionSettings={...settings};
    this.trajectory.setComparisonVisibility(this.uamPredictionSettings);
    // A model choice is not a visibility switch. Clear the request token before
    // reloading so an old model cannot paint over the newly chosen one.
    if(changed && this.trajectory.entityKind==='uam')this.trajectory.clear();
    const toggled=this.setPredictionFor('uam',enabled);
    if(changed && !toggled && enabled){
      const item=this.items.get(this.selected);if(item?.entity?.kind==='uam')void this.trajectory.show(item.entity);
    }
    this.viewer.scene.requestRender();return toggled||changed;
  }
  setPredictionFor(kind,enabled) {
    const field=kind==='uam'?'predictUam':'predictAircraft';
    const next=Boolean(enabled);
    if(next===this[field])return false;
    this[field]=next;
    const item=this.items.get(this.selected);
    if(!next && this.trajectory.entityKind===kind)this.trajectory.clear();
    else if(next && item?.entity?.kind===kind)void this.trajectory.show(item.entity);
    this.viewer.scene.requestRender();
    return true;
  }
  // The state time and position an object is being drawn at, or null. The
  // display runs a little behind the twin so it can interpolate; this is that
  // instant, which is what a path drawn against the picture must use.
  displayAnchor(id) {
    if(!id)return null;
    const samples=this.entityScene.samples;
    const time=samples.renderTime(id);
    if(!Number.isFinite(time))return null;
    const position=samples.positionAt(id,time,this.anchorScratch ??= [0,0,0]);
    const item=this.items.get(id),drawn=item?.position;
    const physical=samples.physicalTiming?.(id);
    return {time:samples.observationTime?.(id,time) ?? time,position:position?[position[0],position[1],position[2]]:null,
      displayPosition:drawn?[drawn.x,drawn.y,drawn.z]:null,
      epoch:samples.epoch,continuity_id:item?.entity?.continuity_id ?? 0,
      phase:item?.entity?.flight_phase,clockRate:physical?.rate ?? samples.clockRate,physicalPlayback:physical};
  }
  setCloudsEnabled(enabled) {this.clouds.apply({enabled:Boolean(enabled)});}
  refreshClouds() {this.clouds.refresh();}
  setVertiportsVisible(visible) {this.setUamDisplay({all:Boolean(visible)});}
  setUamDisplay(patch) {
    const s=this.uamDisplay={all:true,ports:true,routes:true,labels:true,portLabels:true,routeLabels:true,status:true,aircraft:true,paths:true,passengers:true,lights:true,...this.uamDisplay,...patch};
    this.vertiportLayer.setVisible(s.all&&s.ports);
    this.routeLayer.setVisible(s.all&&s.routes);
    this.vertiportLayer.setLabelsVisible(s.portLabels);this.routeLayer.setLabelsVisible(s.routeLabels);
    this.vertiportLayer.setLightsEnabled(s.lights);
    this.flightLayer?.setDisplayOptions(s);
    this.entityScene?.setDisplayOptions('uam',{labels:s.labels,status:s.status});
    this.entityScene?.setLayerVisible('uam',s.all&&s.aircraft);
    this.viewer.scene.requestRender();
  }
  // How large the map draws its own names: vertiports and the route together,
  // so nothing on the infrastructure grows out of step with the rest of it.
  setLabelScale(scale) {
    const changed=[this.vertiportLayer.setLabelScale(scale),this.routeLayer.setLabelScale(scale)].filter(Boolean).length>0;
    if(changed)this.viewer.scene.requestRender();
    return changed;
  }
  // The vertiport being edited stays on the map, drawn faint, so the preview of
  // what it is becoming is the only solid one.
  dimVertiport(id) {this.vertiportLayer.setDimmed(id ? [id] : []);this.viewer.scene.requestRender();}
  // Terrain heights from the most detailed tiles; the ellipsoid when terrain is off or unavailable.
  async groundHeights(points,{strict=false}={}) {
    const C=this.C,provider=this.viewer.terrainProvider;
    // No terrain yet is unknown ground (null: never cached); terrain switched off is the ellipsoid.
    if(!provider || !provider.availability || typeof C.sampleTerrainMostDetailed!=='function')return strict?null:(this.terrainFlat || !this.terrain)?points.map(()=>0):null;
    const samples=await C.sampleTerrainMostDetailed(provider,points.map(p=>C.Cartographic.fromDegrees(p.longitude,p.latitude)));
    return samples.map(sample=>Number.isFinite(sample?.height)?sample.height:(strict?null:0));
  }
  // Ground under a screen position as degrees and metres, or null off the globe.
  groundAt(screen) {
    const target=pickGround(this.viewer.camera,this.viewer.scene,screen,this.scratch);
    const carto=target?this.C.Cartographic.fromCartesian(target):null;
    return carto?{latitude:this.C.Math.toDegrees(carto.latitude),longitude:this.C.Math.toDegrees(carto.longitude),height:Number.isFinite(carto.height)?carto.height:0}:null;
  }
  handleClick(position) {
    if(this.cockpit?.active)return;
    // While a scrap is armed the map is being read, not selected from: a click
    // that landed on a vertiport takes it in or out of the selection and
    // nothing else answers.
    if(this.scrap){
      const hit=this.vertiportLayer.pick(pickThroughAirspace(this.viewer.scene,position));
      if(hit)this.scrap.onToggle(hit.id);
      return;
    }
    if(this.groundPick){
      // Held for the tools: the click puts the preview back under the cursor
      // rather than placing it where the operator is not looking.
      if(this.groundPick.held){this.resumeGroundPick();this.groundPick?.onRelease?.();return;}
      const {resolve}=this.groundPick;this.groundPick=null;this.viewer.canvas.style.cursor='';
      resolve(this.groundAt(position));
      return;
    }
    if(this.routeEditor){
      const hit=this.routeLayer.pick(pickThroughAirspace(this.viewer.scene,position));
      this.routeEditor.onClick({hit,ground:hit?null:this.groundAt(position),screen:{x:position.x,y:position.y}});
      return;
    }
    // A demand line is a thing on the map: clicking it cuts the pair or joins
    // it again, which is the same edit the list makes.
    if(this.demandEditor){
      const pair=this.pairLayer.pick(pickThroughAirspace(this.viewer.scene,position));
      if(pair){this.demandEditor.onPair(pair);return;}
    }
    if(this.vertiportEditor){
      const hit=this.vertiportLayer.pick(pickThroughAirspace(this.viewer.scene,position));
      if(hit){this.vertiportEditor.onSelect({id:hit.id,screen:{x:position.x,y:position.y}});return;}
    }
    // A planned aircraft is a thing on the map like any other: clicking it
    // says which flight it is and where it is in it.
    const picked=this.pickInteraction(position);
    const flight=this.flightLayer?.pick(picked);
    if(flight){this.onFlightPick(flight,{x:position.x,y:position.y});return;}
    const entity=this.pickEntity(position,picked??null,true);
    if(!entity&&this.onVertiportPick&&!this.routeEditor&&!this.demandEditor&&!this.vertiportEditor){
      const port=this.vertiportLayer.pick(picked);
      if(port&&this.onVertiportPick){this.onVertiportPick(port.id);return;}
    }
    this.select(entity,{focus:true});
  }
  // The right button while a placement is armed: the preview stops at the
  // ground under the cursor and the tools are offered there.
  handleRightClick(position) {
    if(this.transitioning || this.entryActive)return;
    const pick=this.groundPick;
    if(pick?.onTools){
      const pose=this.groundAt(position);
      if(!pose)return;
      pick.held=true;pick.last=pose;
      pick.onTools(pose,{x:position.x,y:position.y});
      return;
    }
    if(pick)return;
    // Nothing is being placed: the right button opens what the operator is
    // pointing at, so a saved vertiport is edited without arming anything first.
    if(this.vertiportEditor?.onContextMenu){
      const hit=this.vertiportLayer.pick(pickThroughAirspace(this.viewer.scene,position));
      if(hit){this.vertiportEditor.onContextMenu({id:hit.id,screen:{x:position.x,y:position.y}});return;}
    }
    const flight=this.flightLayer?.pick(this.pickInteraction(position));
    if(flight){this.onFlightPick(flight,{x:position.x,y:position.y},{detailsOnly:true});return;}
    const id=this.pickEntity(position) || ((this.tracking || this.approaching)?this.selected:null);
    if(!id || !this.items.has(id))return;
    // Inspection is independent of the selected camera anchor. Never call
    // select/focus here: re-picking a tracked target would toggle tracking off.
    this.detailId=id;this.refreshDetails({reopen:true});
  }
  refreshDetails(options) {
    if(this.detailId && !this.items.has(this.detailId))this.detailId=null;
    this.onSelect(this.items.get(this.detailId || this.selected)?.entity || null,options);
  }
  detailsTracked() {
    return Boolean((!this.detailId || this.detailId===this.selected) && (this.tracking || this.approaching));
  }
  focusDetail(track=false,options={}) {
    if(this.detailId && this.detailId!==this.selected)this.select(this.detailId);
    this.focus(track,this.motion.now(),options);
  }
  // The next click on the ground answers with its position instead of selecting;
  // null when cancelled or superseded. `onMove` hears the ground under the cursor
  // meanwhile, `onTools` a right click, and `onRelease` a click that ends a hold.
  pickGroundOnce({onMove=null,onTools=null,onRelease=null}={}) {
    this.cancelGroundPick();
    this.viewer.canvas.style.cursor='crosshair';
    return new Promise(resolve=>{this.groundPick={resolve,onMove,onTools,onRelease,held:false};this.pickMoveDirty=Boolean(this.hoverPointer);});
  }
  // The preview follows the cursor again after a hold.
  resumeGroundPick() {
    if(!this.groundPick?.held)return;
    this.groundPick.held=false;this.pickMoveDirty=Boolean(this.hoverPointer);
  }
  // Finish an armed placement at a position the operator chose in the tools
  // instead of with a click on the map.
  commitGroundPick(position) {
    if(!this.groundPick)return;
    const {resolve}=this.groundPick;this.groundPick=null;this.viewer.canvas.style.cursor='';
    resolve(position ?? null);
  }
  // Every frame while armed: the ground under a still cursor changes as tiles
  // arrive, so the pose is re-read and reported only when it differs.
  trackGroundPick() {
    const pick=this.groundPick;
    if(!pick?.onMove || pick.held || !this.hoverPointer)return;
    this.pickMoveDirty=false;
    const position=this.groundAt(this.hoverPointer),last=pick.last;
    if(!position || (last && last.latitude===position.latitude && last.longitude===position.longitude && last.height===position.height))return;
    pick.last=position;pick.onMove(position);
  }
  followVertiport(layout,name,pose) {this.vertiportLayer.follow(layout,name,pose);this.viewer.scene.requestRender();}
  moveVertiportPreview(pose) {this.vertiportLayer.moveFollow(pose);this.viewer.scene.requestRender();}
  cancelGroundPick() {
    if(!this.groundPick)return;
    const {resolve}=this.groundPick;this.groundPick=null;this.viewer.canvas.style.cursor='';resolve(null);
  }
  flyToVertiport(frame,range=520) {
    const C=this.C;this.motion.cancel();this.stopTracking();this.select(null);
    const centre=C.Cartesian3.fromDegrees(frame.longitude,frame.latitude,frame.altitude_m ?? 0);
    if(this.entityScene)this.entityScene.modelsMoving=true;
    const token=this.destinationPreparation?.start(centre);
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(centre,120),{duration:1.6,
      complete:()=>this.destinationPreparation?.arrive(token),
      cancel:()=>{if(this.destinationPreparation?.active?.token===token)this.destinationPreparation.cancel();},
      offset:new C.HeadingPitchRange(C.Math.toRadians(frame.heading_deg ?? 0),-1.05,range)});
  }
  // ---- multi-flight setup ------------------------------------------------
  showDemandPairs(pairs,options={}) {const count=this.pairLayer.show(pairs,options);this.viewer.scene.requestRender();return count;}
  clearDemandPairs() {this.pairLayer.clear();this.viewer.scene.requestRender();}
  // While a demand editor is set, a click on one of those lines answers to it.
  setDemandEditor(editor) {this.demandEditor=editor??null;}
  // The demand network and the route network are both lines between the same
  // decks, and read as each other. While the setup owns the map the route
  // network drops to background: still there for bearings, no longer read as
  // the thing being edited.
  setDemandFocus(active) {
    if(this.routeLayer.setQuiet(Boolean(active)))this.viewer.scene.requestRender();
  }
  // Which of `records` the given screen rectangle encloses. Projection alone
  // would include the far side of the globe, so occlusion is tested too.
  vertiportsInRectangle(rect,records=[]) {
    const C=this.C,v=this.viewer;
    const occluder=v.scene.mode===C.SceneMode.SCENE3D?new C.EllipsoidalOccluder(C.Ellipsoid.WGS84,v.camera.positionWC):null;
    const found=[];
    for(const record of records){
      const frame=record.layout?.frame ?? record;
      if(!Number.isFinite(frame?.longitude)||!Number.isFinite(frame?.latitude))continue;
      const world=C.Cartesian3.fromDegrees(frame.longitude,frame.latitude,frame.altitude_m??0);
      if(occluder&&!occluder.isPointVisible(world))continue;
      const screen=C.SceneTransforms.worldToWindowCoordinates(v.scene,world);
      if(!screen||!Number.isFinite(screen.x))continue;
      if(screen.x<rect.left||screen.x>rect.right||screen.y<rect.top||screen.y>rect.bottom)continue;
      found.push(record.id);
    }
    return found;
  }
  // A drag over the map that gathers what it encloses. The camera is held
  // still while the box is drawn - a drag would otherwise turn the globe - and
  // the vertiports inside are reported once, on release. A click that moved
  // too little to be a box is a single vertiport being taken in or out.
  beginScrap({records=()=>[],onScrap=()=>{},onToggle=()=>{}}={}) {
    this.cancelScrap();
    const v=this.viewer,canvas=v.canvas,controller=v.scene.screenSpaceCameraController;
    // The box is measured against the canvas, so it hangs on the canvas's own
    // parent: the outer container can carry a header or a border and the
    // rectangle would then be drawn a few pixels off the cursor.
    const box=document.createElement('div');box.className='map-scrap';box.hidden=true;
    (canvas.parentNode ?? v.container)?.append(box);
    const state={box,onToggle,inputs:controller.enableInputs,start:null};
    controller.enableInputs=false;canvas.style.cursor='crosshair';
    const at=event=>{const bounds=canvas.getBoundingClientRect();return {x:event.clientX-bounds.left,y:event.clientY-bounds.top};};
    const rectOf=(a,b)=>({left:Math.min(a.x,b.x),top:Math.min(a.y,b.y),right:Math.max(a.x,b.x),bottom:Math.max(a.y,b.y)});
    state.down=event=>{if(event.button!==0)return;state.start=at(event);canvas.setPointerCapture?.(event.pointerId);};
    state.move=event=>{
      if(!state.start)return;
      const rect=rectOf(state.start,at(event));
      box.hidden=false;box.style.left=`${rect.left}px`;box.style.top=`${rect.top}px`;
      box.style.width=`${rect.right-rect.left}px`;box.style.height=`${rect.bottom-rect.top}px`;
    };
    state.up=event=>{
      if(!state.start)return;
      const rect=rectOf(state.start,at(event));state.start=null;box.hidden=true;
      // Too small to be a box: the click handler treats it as one vertiport.
      if(rect.right-rect.left<5||rect.bottom-rect.top<5)return;
      onScrap(this.vertiportsInRectangle(rect,records()));
    };
    canvas.addEventListener('pointerdown',state.down);
    canvas.addEventListener('pointermove',state.move);
    canvas.addEventListener('pointerup',state.up);
    this.scrap=state;
    return true;
  }
  cancelScrap() {
    const state=this.scrap;
    if(!state)return false;
    this.scrap=null;
    const canvas=this.viewer.canvas;
    canvas.removeEventListener('pointerdown',state.down);
    canvas.removeEventListener('pointermove',state.move);
    canvas.removeEventListener('pointerup',state.up);
    this.viewer.scene.screenSpaceCameraController.enableInputs=state.inputs!==false;
    canvas.style.cursor='';state.box.remove();
    return true;
  }
  destroy() {
    this.cockpit?.destroy();
    this.cancelScrap();
    this.destinationPreparation?.cancel();
    this.hybridBuildings?.destroy();
    this.displayResolution?.destroy();
    this.entryAbort?.abort();this.viewer.camera.cancelFlight();
    this.keyboard?.destroy();
    this.removeAnnotationTick?.();this.annotationClock?.destroy();
    this.removeImageryError?.();this.removeFrame?.();this.removeCameraChange?.();document.removeEventListener('visibilitychange',this.onVisibility);
    this.viewer.canvas.removeEventListener('contextmenu',this.onContextMenu);
    this.viewer.canvas.removeEventListener('wheel',this.onWheel);
    this.viewer.canvas.removeEventListener('pointerdown',this.onPointerDown);
    this.viewer.canvas.removeEventListener('pointerleave',this.onPointerLeave);
    this.terrainDisposed=true;this.terrainRevision++;this.placeLabels?.destroy();this.terrain?.destroy();this.cockpitEnvironment?.destroy();this.clouds.destroy();this.buildings.destroy();this.vworldBuildings?.destroy();this.vworld3d?.destroy();this.osmBuildingFocus?.destroy();this.vworld3dFocus?.destroy();this.vworldImagery?.destroy();this.trajectory.destroy();this.flightTrack?.destroy();this.scenarioPassengers?.destroy();this.pairLayer.clear();this.routeLayer.destroy();this.airspaceLayer?.destroy();this.flightLayer?.destroy();this.vertiportLayer.destroy();this.entityScene.destroy();this.viewer.destroy();
  }
}
