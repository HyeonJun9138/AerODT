// Decode/compact a derived flight mesh; never modify the acquired source GLB.
import {fileURLToPath} from 'node:url';
import {NodeIO} from '../../environment/visual_assets/node_modules/@gltf-transform/core/dist/index.modern.js';
import {ALL_EXTENSIONS} from '../../environment/visual_assets/node_modules/@gltf-transform/extensions/dist/index.modern.js';
import {prune, dedup, weld, simplify, getBounds} from '../../environment/visual_assets/node_modules/@gltf-transform/functions/dist/functions.modern.js';
import draco3d from '../../environment/visual_assets/node_modules/draco3dgltf/draco3dgltf.js';
import {MeshoptSimplifier} from '../../environment/visual_assets/node_modules/meshoptimizer/index.module.js';
const [input, output, mode] = process.argv.slice(2);
if (!input || !output || input === output) throw Error('Distinct input/output required');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'draco3d.decoder': await draco3d.createDecoderModule()});
const doc = await io.read(input);
for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
if (mode === 'simplify') {
  await MeshoptSimplifier.ready;
  // NASA mesh has a normal split at nearly every triangle. Position topology
  // must be shared before decimation; regenerate smooth normals afterwards.
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) p.setAttribute('NORMAL', null);
  await doc.transform(weld(), simplify({simplifier:MeshoptSimplifier, ratio:0.08, error:0.0005}));
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const pos=p.getAttribute('POSITION'), xyz=pos.getArray(), ix=p.getIndices().getArray(), n=new Float32Array(xyz.length);
    for(let k=0;k<ix.length;k+=3){const a=ix[k]*3,b=ix[k+1]*3,c=ix[k+2]*3;
      const u=[xyz[b]-xyz[a],xyz[b+1]-xyz[a+1],xyz[b+2]-xyz[a+2]],v=[xyz[c]-xyz[a],xyz[c+1]-xyz[a+1],xyz[c+2]-xyz[a+2]];
      const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      for(const j of [a,b,c]) for(let d=0;d<3;d++) n[j+d]+=cross[d];
    }
    for(let i=0;i<n.length;i+=3){const l=Math.hypot(n[i],n[i+1],n[i+2]);if(l<1e-15){n[i+1]=1;}else for(let d=0;d<3;d++)n[i+d]/=l;}
    p.setAttribute('NORMAL',doc.createAccessor().setType('VEC3').setArray(n).setBuffer(pos.getBuffer()));
  }
}
if(mode === 'floor') {
  const scene=doc.getRoot().getDefaultScene()??doc.getRoot().listScenes()[0], bounds=getBounds(scene);
  let scale=1;
  if(process.argv[5] === 'airtaxi') {
    const reference=await io.read(fileURLToPath(new URL('../../../digital_twin/model_library/visual_assets/aircraft/civilian/projectairsim_airtaxi/model.glb',import.meta.url)));
    const rb=getBounds(reference.getRoot().getDefaultScene()??reference.getRoot().listScenes()[0]);
    const extent=b=>Math.max(...b.max.map((v,i)=>v-b.min[i]));
    scale=extent(rb)/extent(bounds);
    console.log(JSON.stringify({displayScale:scale,sourceExtent:extent(bounds),targetExtent:extent(rb)}));
  }
  const root=doc.createNode('Flight_ground_datum').setScale([scale,scale,scale]).setTranslation([-(bounds.min[0]+bounds.max[0])*scale/2,-bounds.min[1]*scale,-(bounds.min[2]+bounds.max[2])*scale/2]);
  for(const node of scene.listChildren()){scene.removeChild(node);root.addChild(node);}scene.addChild(root);
}
await doc.transform(prune(), dedup());
await io.write(output, doc);
console.log(JSON.stringify({output, vertices:doc.getRoot().listMeshes().reduce((n,m)=>n+m.listPrimitives().reduce((v,p)=>v+p.getAttribute('POSITION').getCount(),0),0)}));


