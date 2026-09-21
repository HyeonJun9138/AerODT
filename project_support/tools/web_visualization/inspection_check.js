// Explicit test fixtures: no telemetry or credentials are fetched by this page.
import {LiveGlobe} from '/visualization/globe.js';
import {SelectionPanel} from '/static/selection_panel.js';
const C=globalThis.Cesium,$=id=>document.getElementById(id);
$('loading').hidden=true;
document.querySelector('header .eyebrow').textContent='TEST / NOT LIVE';
const panel=new SelectionPanel(C);
const globe=new LiveGlobe(C,'globe',{terrainEnabled:false,creditContainer:$('map-credits'),onSelect:e=>panel.show(e),onHover:(e,p)=>panel.hover(e,p)});
globe.setBuildingsEnabled(false);globe.setSunEnabled(false);
const assets=await (await fetch('/api/visual-assets')).json();panel.setAssets(assets);globe.setAssets(assets);
const now=Date.now()/1000;
const entity=(id,kind,lat,lon,asset)=>({entity_id:id,name:`TEST ${kind.toUpperCase()} / NOT LIVE`,kind,latitude_deg:lat,longitude_deg:lon,altitude_m:3000,
 position_ecef_m:[...Object.values(C.Cartesian3.fromDegrees(lon,lat,3000))],velocity_ecef_mps:[3,4,0],heading_deg:null,
 state_time:now,observation_time:now,received_time:now,quality:'valid',source:'inspection_fixture',derivation:'observed',provenance:'fixture',visual_asset_id:asset,orientation_source:'unavailable'});
const aircraft=entity('test:aircraft','aircraft',37.5665,126.978,'amvlab_a320'),satellite=entity('test:satellite','satellite',37.65,127.15,'generic_satellite');
globe.replace({sequence:1,state_time:now,entities:[aircraft,satellite]});
function interact(id,type) {
  globe.entityScene.updateLod(globe.selected);const item=globe.items.get(id);
  const point=C.SceneTransforms.worldToWindowCoordinates(globe.viewer.scene,item.position);
  globe.viewer.screenSpaceEventHandler.getInputAction(type)(type===C.ScreenSpaceEventType.MOUSE_MOVE?{endPosition:point}:{position:point});
}
$('qa-hover').onclick=()=>interact(aircraft.entity_id,C.ScreenSpaceEventType.MOUSE_MOVE);
$('qa-aircraft').onclick=()=>interact(aircraft.entity_id,C.ScreenSpaceEventType.LEFT_CLICK);
$('qa-satellite').onclick=()=>interact(satellite.entity_id,C.ScreenSpaceEventType.LEFT_CLICK);
$('qa-fallback').onclick=()=>{panel.setAssets({assets:[{asset_id:'broken',uri:'/visual-assets/nonexistent.glb',metadata_uri:'/visual-assets/aircraft/civilian/amvlab_a320/asset.json',title:'TEST FALLBACK'}]});panel.show({...aircraft,entity_id:'test:broken',visual_asset_id:'broken'});};
$('clear').onclick=()=>globe.select(null);
$('focus').onclick=()=>globe.focus();$('track').onclick=()=>globe.focus(true);
$('qa-verify').onclick=()=>{
  const item=globe.items.get(aircraft.entity_id);
  $('qa-result').textContent=JSON.stringify({hoverVisible:!$('hover-card').hidden,pointOutline:item.point.outlineWidth,
    selected:globe.selected,preview:$('preview-status').textContent,previewCanvases:$('model-preview').querySelectorAll('canvas').length,
    fallbackVisible:!$('preview-image').hidden && $('preview-image').naturalWidth>0,totalState:globe.items.size},null,2);
};
window.addEventListener('pagehide',()=>{panel.destroy();globe.destroy();},{once:true});
