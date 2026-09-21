import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {NodeIO} from '../../../environment/visual_assets/node_modules/@gltf-transform/core/dist/index.modern.js';
import {getBounds} from '../../../environment/visual_assets/node_modules/@gltf-transform/functions/dist/functions.modern.js';
const lib=new URL('../../../../digital_twin/model_library/visual_assets/aircraft/civilian/',import.meta.url);
const io=new NodeIO();
async function load(id,file='flight_model.glb'){return io.read(fileURLToPath(new URL(`${id}/${file}`,lib)));}
const extent=doc=>{const b=getBounds(doc.getRoot().listScenes()[0]);return Math.max(...b.max.map((v,i)=>v-b.min[i]));};
test('flight substitutes match AirTaxi extent while keeping their ground datum',async()=>{
  const reference=extent(await load('projectairsim_airtaxi','model.glb'));
  for(const id of ['kp2a','amvlab_evtol','joby_s4']){
    const doc=await load(id),bounds=getBounds(doc.getRoot().listScenes()[0]);
    assert.ok(Math.abs(extent(doc)-reference)<.002,id);
    assert.ok(Math.abs(bounds.min[1])<.002,`${id} rests on ground`);
  }
});
test('Joby retains six tilting assemblies and front connecting necks with distinct white body / dark windows',async()=>{
  const doc=await load('joby_s4'),nodes=doc.getRoot().listNodes();
  const meta=JSON.parse(readFileSync(new URL('joby_s4/asset.json',lib),'utf8'));
  assert.equal(meta.flight_visual.rotors.tilt.nodes.length,6);
  for(let i=1;i<=2;i++){
    const hinge=nodes.find(n=>n.getName()===`Joby_hinge_${i}`);
    assert.ok(hinge.listChildren().some(n=>n.getName()===`Joby_tilt_neck_${i}`));
    const rotor=hinge.listChildren().find(n=>n.getName()===`AeroDT_Rotor_${i}`);
    assert.ok(Math.abs(rotor.getTranslation()[1]-.025)<1e-6);
    assert.ok(Math.abs(hinge.getTranslation()[2]+.465)<1e-6);
  }
  const materials=doc.getRoot().listMaterials();
  assert.ok(materials.find(m=>m.getName()==='Material__25').getBaseColorFactor().slice(0,3).every(v=>v>.9));
  assert.ok(materials.find(m=>m.getName()==='03_-_Default').getBaseColorFactor().slice(0,3).every(v=>v<.1));
});

test('X57 flight livery has white body and dark glass without modifying acquired model',async()=>{
 const doc=await load('x_57');const materials=doc.getRoot().listMaterials();
 const body=materials.find(m=>m.getName()==='Pearl white fuselage');
 const glass=materials.find(m=>m.getName()==='Dark blue cabin glass');
 assert.ok(body&&glass);assert.ok(body.getBaseColorFactor()[0]>.9);assert.ok(glass.getBaseColorFactor()[0]<.03);
 assert.equal(doc.getRoot().listNodes().filter(n=>n.getName().startsWith('X57_inboard_rotor_')).length,12);
 const tips=doc.getRoot().listNodes().filter(n=>/^X57_tip_(rotor|motor)_/.test(n.getName()));
 assert.equal(tips.length,4);
 for(const node of tips)for(const primitive of node.getMesh().listPrimitives())
   assert.ok(primitive.getMaterial().getBaseColorFactor().slice(0,3).every(v=>v<.02),'tip propeller and pod must be black');
});

test('KP2 source logo PNGs are embedded without repainting and only bounded surface patches are added',async()=>{
  const doc=await load('kp2a');
  const materials=doc.getRoot().listMaterials();
  let triangles=0;
  for(const name of ['KADA_Logo','VIBUM_Logo']){
    const mat=materials.find(m=>m.getName()===name+'_restored');assert.ok(mat,name);
    assert.equal(mat.getAlphaMode(),'BLEND');
    assert.deepEqual(Buffer.from(mat.getBaseColorTexture().getImage()),readFileSync(new URL(`kp2a/decals/${name}.png`,lib)));
  }
  for(const n of doc.getRoot().listNodes().filter(n=>n.getName().endsWith('_restored'))){
    for(const p of n.getMesh().listPrimitives()){
      triangles+=(p.getIndices()?.getCount()??p.getAttribute('POSITION').getCount())/3;
      const uv=p.getAttribute('TEXCOORD_0').getArray();assert.ok([...uv].every(v=>v>=-1e-6&&v<=1+1e-6));
    }
  }
  assert.equal(triangles,296);
  assert.equal(doc.getRoot().listNodes().filter(n=>n.getName().endsWith('_restored')).length,4);
  const layout=JSON.parse(readFileSync(new URL('kp2a/decals/display_layout.json',lib),'utf8'));
  const sides=layout.marks.filter(m=>m.surface==='Body');
  assert.equal(sides.length,2);
  assert.ok(sides.every(m=>m.center_m[1]<-1 && m.half_extent_m[2]>=.9));
  assert.equal(layout.marks.filter(m=>m.surface==='Top').length,2);
});
