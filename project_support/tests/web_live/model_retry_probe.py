"""Isolated real-Cesium cold-load/retry probe; no live World calls."""
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from digital_twin.model_library.visual_catalog import read_visual_catalog
ROOT=Path(__file__).resolve().parents[3]
ASSETS=ROOT/'digital_twin/model_library/visual_assets'
app=FastAPI()
app.mount('/visualization',StaticFiles(directory=ROOT/'digital_twin/visualization/web'),name='visualization')
app.mount('/visual-assets',StaticFiles(directory=ASSETS),name='assets')
@app.get('/catalog')
def catalog():return read_visual_catalog(ASSETS)
@app.get('/')
def index():
 return HTMLResponse('''<!doctype html><meta charset="utf-8"><title>Model retry isolated probe</title>
 <link rel="stylesheet" href="https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/Widgets/widgets.css">
 <script src="https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/Cesium.js"></script>
 <body><button id="fail">모델 준비 오류 시험</button><pre id="status">loading</pre><div id="map" style="height:500px"></div>
 <script type="module">
 import {EntityScene} from '/visualization/entity_scene.js';
 const C=Cesium,widget=new C.CesiumWidget('map',{baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),skyBox:false,skyAtmosphere:false});
 const scene=new EntityScene(C,widget),catalog=await fetch('/catalog').then(r=>r.json());scene.setAssets(catalog);
 const asset=catalog.assets.find(a=>a.asset_id==='kp2a')||catalog.assets.find(a=>a.kind==='aircraft');
 const pos=C.Cartesian3.fromDegrees(127.077,37.5435,100);
 scene.replace({sequence:1,state_time:1,entities:[{entity_id:'probe',kind:'uam',name:'PROBE',quality:'valid',visual_asset_id:asset.asset_id,position_ecef_m:[pos.x,pos.y,pos.z],latitude_deg:37.5435,longitude_deg:127.077,altitude_m:100,heading_deg:0}]});
 widget.camera.lookAt(pos,new C.HeadingPitchRange(.6,-.5,100));widget.camera.lookAtTransform(C.Matrix4.IDENTITY);
 let frames=0,oldModel=null,recovered=false;
 widget.scene.preRender.addEventListener(()=>{
  const now=performance.now();scene.retirePreparation(now);scene.updateLod('probe',now);scene.updatePositions(now);frames++;
  const item=scene.items.get('probe');if(oldModel&&item.model&&item.model!==oldModel&&item.model.ready&&!item.failed)recovered=true;
  document.querySelector('#status').textContent=JSON.stringify({ready:item.model?.ready||false,show:item.model?.show||false,failed:item.failed,failures:item.modelFailures||0,recovered,frames});
 });
 document.querySelector('#fail').onclick=()=>{const item=scene.items.get('probe');if(!item.model?.ready)return;oldModel=item.model;item.model.errorEvent.raiseEvent(new Error('isolated test failure'));};
 </script>''')
