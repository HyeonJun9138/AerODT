// Does the cabin this pipeline built actually work as a cabin? Renders the
// airframe and, from the seated eye point, ray-tests three things that a
// screenshot alone cannot settle:
//
//   1. looking forward leaves the shell through a transparent material -- the
//      window band is really glazed, not merely recoloured somewhere hidden,
//   2. every instrument screen is inside the shell rather than out in the air,
//   3. the seats sit inside the fuselage, not through its floor or roof.
//
// Three.js under headless Edge. Not Cesium and not Unreal: this checks the
// asset, not how either engine will finally draw it.
//
//   node project_support/tools/visual_assets/validate_openvsp_cabin.cjs \
//       data/workspace/visual_assets/intake_nasa/build/liftpcruise
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const {chromium} = require('../../environment/visual_assets/node_modules/playwright');

const ENV = path.resolve(__dirname, '../../environment/visual_assets/node_modules');
const folders = process.argv.slice(2);
if (!folders.length) {console.error('give one or more build folders'); process.exit(2);}

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#aeb9c0">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js",
 "three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
const p = new URLSearchParams(location.search);
window.T = T;
const renderer = new T.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
renderer.setSize(1100, 720); document.body.append(renderer.domElement);
const scene = new T.Scene(); scene.background = new T.Color('#aeb9c0');
scene.add(new T.HemisphereLight('#ffffff', '#5a6672', 2.2));
const sun = new T.DirectionalLight('#fff6e8', 2.0); sun.position.set(1, 2, 1.5); scene.add(sun);
const meta = await (await fetch(p.get('meta'))).json();
window.meta = meta;
const gltf = await new GLTFLoader().loadAsync(p.get('model'));
const model = gltf.scene; scene.add(model); window.model = model;
const box = new T.Box3().setFromObject(model), size = box.getSize(new T.Vector3());
const mid = box.getCenter(new T.Vector3());
const camera = new T.PerspectiveCamera(55, 1100/720, 0.01, size.length()*12);
window.renderView = (mode, fov) => {
  camera.fov = fov; camera.updateProjectionMatrix();
  const eye = new T.Vector3(...meta.cockpit.eye);
  const f = new T.Vector3(...meta.cockpit.forward);
  if (mode === 'exterior') {
    camera.position.set(mid.x + size.length()*.55, mid.y + size.length()*.30, mid.z + size.length()*.55);
    camera.lookAt(mid);
  } else if (mode === 'front') {
    camera.position.set(mid.x, mid.y + size.y*.15, mid.z + f.z*size.length()*.62);
    camera.lookAt(mid);
  } else if (mode === 'pilot') {
    camera.position.copy(eye); camera.lookAt(eye.clone().add(f.clone().multiplyScalar(size.length())));
  } else if (mode === 'panel') {
    const c = new T.Vector3(...meta.cockpit.screens[1].center);
    camera.position.copy(eye); camera.lookAt(c);
  } else if (mode === 'cabin') {
    camera.position.copy(eye).add(f.clone().multiplyScalar(-size.z*.09)).setY(eye.y + size.y*.05);
    camera.lookAt(eye.clone().add(f.clone().multiplyScalar(size.length()*.02)));
  }
  renderer.render(scene, camera);
};
window.ready = true;
</script></body>`;

function serve(root) {
  const types = {'.js': 'text/javascript', '.glb': 'model/gltf-binary', '.json': 'application/json'};
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      return response.end(PAGE);
    }
    const from = url.pathname.startsWith('/three/') ? ENV : root;
    const file = path.join(from, url.pathname.startsWith('/three/') ? url.pathname : path.basename(url.pathname));
    if (!fs.existsSync(file)) {response.writeHead(404); return response.end('no');}
    response.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream'});
    fs.createReadStream(file).pipe(response);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  let failures = 0;
  try {
    for (const folder of folders) {
      const root = path.resolve(folder);
      const parts = JSON.parse(fs.readFileSync(path.join(root, 'parts.json'), 'utf8'));
      const glb = path.basename(parts.glb ?? '');
      const server = await serve(root);
      const port = server.address().port;
      const page = await browser.newPage({viewport: {width: 1100, height: 720}});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/?model=/${glb}&meta=/parts.json`);
      await page.waitForFunction(() => window.ready, {timeout: 90000});
      const shots = path.join(root, 'views');
      fs.mkdirSync(shots, {recursive: true});
      for (const [mode, fov] of [['exterior', 55], ['front', 45], ['pilot', 70], ['panel', 40], ['cabin', 80]]) {
        await page.evaluate(([m, f]) => window.renderView(m, f), [mode, fov]);
        await page.screenshot({path: path.join(shots, `${mode}.png`)});
      }
      const report = await page.evaluate(() => {
        const {T, model, meta} = window;
        model.traverse(o => {if (o.material) o.material.side = T.DoubleSide;});
        const eye = new T.Vector3(...meta.cockpit.eye);
        const shell = direction => new T.Raycaster(eye, direction.clone().normalize())
          .intersectObject(model, true).filter(h => !h.object.name.startsWith('Cabin_'));
        const ahead = shell(new T.Vector3(...meta.cockpit.forward))[0];
        // Inside the cabin means inside the fuselage, which is a question about
        // the body the seats are in. A first-hit test answers a different one:
        // a boom or a rotor crossing the line of sight would read as a screen
        // out in the air, which it is not.
        // GLTFLoader rewrites node names that contain characters an animation
        // path cannot hold, so the name in the file is not the name on the
        // object. Compare on letters and digits alone.
        // Glazing gives the fuselage a second primitive, and a node with more
        // than one becomes a Group whose meshes carry suffixed names. So the
        // match is on the object of any type, and the box comes from whatever
        // hangs under it.
        const plain = value => String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
        const wanted = plain(meta.cabin.fuselage);
        let cabinBody = null, found = null;
        model.traverse(o => {if (!found && plain(o.name) === wanted) found = o;});
        if (found) cabinBody = new T.Box3().setFromObject(found);
        const screens = meta.cockpit.screens.map(s => {
          const target = new T.Vector3(...s.center);
          const hit = shell(target.clone().sub(eye))[0];
          return {id: s.id, reach: eye.distanceTo(target),
                  occluded_at: hit && hit.distance < eye.distanceTo(target) ? hit.object.name : null,
                  inside: Boolean(cabinBody && cabinBody.containsPoint(target))};
        });
        const seats = [];
        model.traverse(o => {if (/^Cabin_passenger_\d+$/.test(o.name)) {
          const box = new T.Box3().setFromObject(o); seats.push(box.getCenter(new T.Vector3()).toArray());
        }});
        const body = cabinBody;
        if (!body) return {fuselage_found: false, fuselage: meta.cabin.fuselage,
                           screens: [], seats_inside_body: false, seat_count: 0,
                           forward_material: null, forward_transparent: false};
        return {fuselage_found: true,
                forward_material: ahead ? ahead.object.material.name : null,
                forward_transparent: ahead ? Boolean(ahead.object.material.transparent) : false,
                forward_distance: ahead ? ahead.distance : null,
                screens,
                seats_inside_body: seats.every(s => body.containsPoint(new T.Vector3(...s))),
                fuselage: meta.cabin.fuselage,
                seat_count: seats.length};
      });
      await page.close();
      server.close();
      const ok = report.fuselage_found && report.forward_transparent
        && report.screens.length > 0 && report.screens.every(s => s.inside)
        && report.seats_inside_body && !errors.length;
      failures += ok ? 0 : 1;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${path.basename(root).padEnd(36)} `
        + `look-ahead=${report.forward_material ?? 'nothing'}`
        + `${report.forward_transparent ? ' (glazed)' : ' (SOLID)'} `
        + `· screens inside ${report.screens.filter(s => s.inside).length}/${report.screens.length} `
        + `· ${report.seat_count} seats ${report.seats_inside_body ? 'inside' : 'OUTSIDE'} the fuselage`);
      if (errors.length) console.log('      page errors:', errors.slice(0, 3).join(' | '));
      fs.writeFileSync(path.join(root, 'cabin_validation.json'),
        JSON.stringify({renderer: 'Three.js / headless Edge WebGL, not Cesium or Unreal',
                        page_errors: errors, ...report}, null, 2));
    }
  } finally {
    await browser.close();
  }
  process.exitCode = failures ? 1 : 0;
})().catch(error => {console.error(error); process.exitCode = 1;});
