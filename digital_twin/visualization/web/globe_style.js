import {BUILDING_COLOURS} from './building_streaming.js';
import {shade} from './building_appearance.js';
// Match ICDCDT/SDC's dark satellite-emphasis presentation, not physical state.
export function applySceneStyle(C, scene) {
  scene.globe.baseColor = C.Color.fromCssColorString('#07111d');
  scene.backgroundColor = C.Color.fromCssColorString('#050c13');
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.dynamicAtmosphereLighting = false;
  scene.skyBox.show = true;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.fog.enabled = true;
  // Tiles fading into the haze do not need refining: a stronger factor keeps a
  // high oblique view from requesting hundreds of far tiles it cannot show.
  scene.fog.screenSpaceErrorFactor = 4;
  if(scene.postProcessStages?.fxaa)scene.postProcessStages.fxaa.enabled=true;
}

export function applyImageryStyle(layer, sunEnabled = false) {
  // Close-up imagery has no distant atmospheric brightening. Lift midtones in
  // inspection mode instead of retaining the dark satellite-emphasis preset.
  layer.brightness = sunEnabled ? .56 : .9;
  layer.contrast = sunEnabled ? 1.28 : 1.08;
  layer.saturation = sunEnabled ? .5 : .65;
  layer.gamma = sunEnabled ? .88 : 1.12;
}

// Cesium OSM Buildings carries baked per-feature colours that read as olive
// over this dark imagery. Presentation only: geometry, estimated height and
// provider attribution are untouched; only the drawn colour is replaced. The
// ramp is neutral so amber aircraft and cyan satellites stay legible above it.
// `look` is the operator's hue and level, from building_appearance. A tileset's
// colours are a style rather than a shader, so recolouring one means handing it
// a new style; the ramp itself is unchanged, only what each band is shaded to.
export function buildingStyle(C, look = {}) {
  const of = colour => shade(colour, look);
  return new C.Cesium3DTileStyle({
    color: {
      conditions: [
        // Number() is required, not cosmetic: comparing a missing height
        // directly throws and would take the whole tileset's styling down.
        // A missing height becomes NaN, fails every test and lands on the base.
        ...BUILDING_COLOURS.slice(0,-1).map(([height,colour])=>[`Number(\${feature['cesium#estimatedHeight']}) >= ${height}`,`color('${of(colour)}')`]),
        ["true", `color('${of(BUILDING_COLOURS.at(-1)[1])}')`]
      ]
    }
  });
}

// Presentation only: neither observer state nor Live Twin time is modified.
export function setSunLighting(scene, enabled) {
  scene.globe.enableLighting = enabled;
  scene.globe.dynamicAtmosphereLighting = enabled;
  const layers=scene.globe.imageryLayers;
  for(let i=0;i<(layers?.length ?? 0);i++) {
    const layer=layers.get(i);
    if(layer.aerodtRole!=='place_labels')applyImageryStyle(layer,enabled);
  }
}

// Decorative, not a star catalogue. Six tiny static cube faces, no extra feed.
export function createStarSkyBox(C,createCanvas=()=>document.createElement('canvas')) {
  let seed=173;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const sources={};
  for(const side of ['positiveX','negativeX','positiveY','negativeY','positiveZ','negativeZ']) {
    const canvas=createCanvas();canvas.width=canvas.height=1024;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#050c13';ctx.fillRect(0,0,1024,1024);
    for(let i=0;i<120;i++) {
      const x=2+random()*1020,y=2+random()*1020,r=.35+random()*.75;
      ctx.fillStyle=`rgba(195,211,228,${.18+random()*.4})`;
      ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
    }
    sources[side]=canvas;
  }
  return new C.SkyBox({sources});
}
