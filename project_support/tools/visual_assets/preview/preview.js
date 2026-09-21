import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
const status = document.querySelector('#status');
const flightCapture = new URLSearchParams(location.search).get('variant') === 'flight';
const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
if(flightCapture){renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;}
renderer.setSize(flightCapture?960:480,flightCapture?640:340); renderer.setPixelRatio(1); renderer.setClearColor(flightCapture?0x77848c:0x121f32);
document.querySelector('#stage').append(renderer.domElement);
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = new RoomEnvironment();
scene.environment = pmrem.fromScene(environment,0.04).texture;
environment.dispose();pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xffffff,0x46597b,flightCapture?1.2:3));
const sun = new THREE.DirectionalLight(0xffffff,flightCapture?1.8:3); sun.position.set(3,5,4); scene.add(sun);
const camera = new THREE.PerspectiveCamera(35,flightCapture?1.5:480/340,0.001,1000);
const controls = new OrbitControls(camera,renderer.domElement);
const draco = new DRACOLoader().setDecoderPath('/vendor/examples/jsm/libs/draco/gltf/');
const loader = new GLTFLoader().setDRACOLoader(draco);
let active;
let busy=false;
function setBusy(value){busy=value;controls.enabled=!value;for(const button of document.querySelectorAll('button'))button.disabled=value;}
async function showAsset(asset){
  if(busy)return;
  setBusy(true);
  try{
    const result=await renderAsset(asset);
    const response=await fetch('/qa-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
    if(!response.ok)throw Error('검증 결과 저장 실패');
    status.textContent=asset.title+' · 회전/확대 가능';
  }
  catch(e){status.textContent=String(e);}
  finally{setBusy(false);}
}
function dispose(object) {
  object.traverse(o=>{o.geometry?.dispose(); const materials=o.material?(Array.isArray(o.material)?o.material:[o.material]):[]; for(const m of materials){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose();}});
}
function draw(){renderer.render(scene,camera);}
controls.addEventListener('change',draw);
const catalog = await (await fetch('/library/catalog.json')).json();
// Optional bounded QA selection; never load unrelated models for a small intake.
const requested = new Set((new URLSearchParams(location.search).get('ids') || '').split(',').filter(Boolean));
const rows = requested.size ? catalog.assets.filter(row => requested.has(row.asset_id)) : catalog.assets;
const assets = await Promise.all(rows.map(async row=>({...row,...await(await fetch('/library/'+row.metadata)).json()})));
function filter(){const term=document.querySelector('#search').value.toLowerCase(),cat=document.querySelector('#category').value;for(const card of document.querySelectorAll('.card'))card.hidden=!!((cat&&card.dataset.category!==cat)||!card.textContent.toLowerCase().includes(term));}
document.querySelector('#search').addEventListener('input',filter);document.querySelector('#category').addEventListener('change',filter);
async function renderAsset(asset){
  if(active){scene.remove(active);dispose(active);active=null;}
  const visual=flightCapture?(asset.flight_visual??asset.model):asset.model;
  const gltf=await loader.loadAsync('/library/'+asset.metadata.replace('asset.json',visual.path));
  if(flightCapture){
    // Neutral VTOL portrait, including authored hinge offsets (KP2 / EVTOL).
    for(const spec of visual.rotors?.tilt?.nodes??[]){
      const n=gltf.scene.getObjectByName(spec.name);if(!n)throw Error('Missing hinge '+spec.name);
      const axis=new THREE.Vector3(...({x:[1,0,0],y:[0,1,0],z:[0,0,1]}[spec.axis]));
      n.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis,(spec.offset_deg??0)*Math.PI/180));
    }
  }
  const box=new THREE.Box3().setFromObject(gltf.scene),size=box.getSize(new THREE.Vector3()),extent=Math.max(size.x,size.y,size.z);
  if(!Number.isFinite(extent)||extent<=0)throw Error('Empty or nonfinite scene');
  const centre=box.getCenter(new THREE.Vector3());
  const group=new THREE.Group();group.add(gltf.scene);gltf.scene.position.sub(centre);group.scale.setScalar(2/extent);scene.add(group);active=group;
  controls.target.set(0,0,0);camera.position.set(...(flightCapture?({kp2a:[2.5,1.2,2.8],joby_s4:[2.6,1.4,2.7],amvlab_evtol:[2.5,1.8,2.8],x_57:[2.5,1.5,2.8],projectairsim_airtaxi:[2.6,1.3,2.7]}[asset.asset_id]??[2.5,1.4,2.8]):[2.7,1.9,2.7]));if(flightCapture)camera.position.multiplyScalar(({joby_s4:.7,x_57:.8,kp2a:.86,amvlab_evtol:.85,projectairsim_airtaxi:.88})[asset.asset_id]??1);camera.lookAt(0,0,0);controls.update();
  await renderer.compileAsync(scene,camera);draw();
  const triangles=renderer.info.render.triangles;if(triangles<1)throw Error('No rendered triangles');
  const thumbnail=renderer.domElement.toDataURL('image/jpeg',flightCapture?.94:.87);
  return {asset_id:asset.asset_id,sha256:visual.sha256,variant:flightCapture?'flight':'source',status:'passed',renderer:'Three.js r180 WebGL',triangles,native_extent:extent,
    scene_bounds:{min:box.min.toArray(),max:box.max.toArray()},animation_clips:gltf.animations.map(x=>x.name),
    scope:flightCapture?'Current flight visual, neutral VTOL hinge pose, fitted front-quarter portrait; visual capture only.':'Default scene load, shader compilation and one rendered frame. No animation/scale/flight-direction certification.',thumbnail};
}
for(const asset of assets){
  const card=document.createElement('article');card.className='card';card.dataset.category=asset.category;card.dataset.id=asset.asset_id;
  const img=document.createElement('img');img.alt=asset.title;if(asset.thumbnail)img.src='/library/'+asset.metadata.replace('asset.json',asset.thumbnail.path);
  const info=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('p'),rights=document.createElement('p'),button=document.createElement('button');
  title.textContent=asset.title;detail.textContent=asset.asset_id+' · '+asset.representation;rights.textContent=asset.rights.label+(asset.rights.public_export?'':' · 공개 배포 보류');
  if(!asset.rights.public_export)rights.className='bad';button.textContent='3D 보기';button.onclick=()=>showAsset(asset);
  info.append(title,detail,rights,button);card.append(img,info);document.querySelector('#gallery').append(card);
}
status.textContent=`${assets.length}개 모델 · 전체 검증 버튼으로 웹 렌더링을 확인하세요`;
document.querySelector('#run').onclick=async()=>{
  if(busy)return;
  setBusy(true);let passed=0,failed=0;
  try{
  for(const asset of assets){
    status.textContent=`검증 중 ${passed+failed+1}/${assets.length} · ${asset.title}`;
    let result;
    try{result=await renderAsset(asset);document.querySelector(`[data-id="${asset.asset_id}"] img`).src=result.thumbnail;passed++;}
    catch(e){result={asset_id:asset.asset_id,sha256:asset.model.sha256,status:'failed',error:String(e)};failed++;}
    const response=await fetch('/qa-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
    if(!response.ok)throw Error('검증 결과 저장 실패');
  }
  status.textContent=`전체 검증 완료 · 성공 ${passed} / 실패 ${failed} / 합계 ${assets.length}`;
  }catch(e){status.textContent=String(e);}finally{setBusy(false);}
};
