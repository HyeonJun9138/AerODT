// Faint interiors and boundaries offer hover info; sparse hatching is visual.
// Application picks prefer aircraft or editing objects behind an airspace.
// Server geometry and source attribution are preserved.
export const KIND_STYLE = {
  prohibited: {color: '#ff4d5e', label: '비행금지구역', outline: .95},
  restricted: {color: '#ff9f43', label: '비행제한구역', outline: .9},
  danger: {color: '#ffd166', label: '위험구역', outline: .85},
  control: {color: '#7fb3ff', label: '관제권', outline: .7},
  approach: {color: '#8fc4ff', label: '접근관제구역', outline: .45},
  atz: {color: '#9ad0ff', label: '비행장교통구역', outline: .7},
  ua: {color: '#7fe9a5', label: '초경량비행장치공역', outline: .7},
  military: {color: '#c58cff', label: '군작전구역', outline: .6},
  training: {color: '#b39dff', label: '훈련구역', outline: .6},
  corridor: {color: '#7fe9f5', label: '시계비행로·한강회랑', outline: .8},
  other: {color: '#a9c3cd', label: '기타 공역', outline: .6},
};
// Kinds too large to read as zones over a city: drawn only if asked for.
export const HIDDEN_KINDS = new Set(['fir', 'adiz']);
export const CREDIT = '공역: 국토교통부 항공정보도 (공간정보 오픈플랫폼)';
const OUTLINE_WIDTH = 1.6;
// One shared, earth-fixed tangent plane for Korean airspace. Zoom levels share
// the same origin, so the pattern never slides on the map.
const lon = 127 * Math.PI / 180, lat = 37.5 * Math.PI / 180;
const radius = 6378137 / Math.sqrt(1 - .00669437999014 * Math.sin(lat) ** 2);
const HATCH_ORIGIN = {x: radius * Math.cos(lat) * Math.cos(lon), y: radius * Math.cos(lat) * Math.sin(lon), z: radius * (1 - .00669437999014) * Math.sin(lat)};
const HATCH_ANGLES = [30, 60, 120, 150];
const HATCH_DIRECTIONS = new Map(HATCH_ANGLES.map(angle => {
  const a = angle * Math.PI / 180;
  return [angle, {x: -Math.sin(lon) * Math.cos(a) - Math.sin(lat) * Math.cos(lon) * Math.sin(a),
    y: Math.cos(lon) * Math.cos(a) - Math.sin(lat) * Math.sin(lon) * Math.sin(a), z: Math.cos(lat) * Math.sin(a)}];
}));

// Stable per logical zone (including all of its polygon parts), never camera-
// dependent or random per redraw. Four orientations bound GPU batch count.
export function hatchAngleForFeature(feature) {
  const key = String(feature.id ?? feature.properties?.name ?? JSON.stringify(feature.geometry));
  let hash = 2166136261;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return HATCH_ANGLES[(hash >>> 0) % HATCH_ANGLES.length];
}

// Ground metres, in nested powers of two. Hold a level between 32 and 88 px;
// the overlap prevents repeated switching around a zoom boundary.
export function hatchSpacingForScale(metresPerPixel, current = null) {
  if (!(Number.isFinite(metresPerPixel) && metresPerPixel > 0)) return current ?? 4000;
  const min = 31.25, max = 128000;
  let spacing = current ?? Math.max(min, Math.min(max, 125 * 2 ** Math.round(Math.log2(metresPerPixel * 48 / 125))));
  while (spacing / metresPerPixel < 32 && spacing < max) spacing *= 2;
  while (spacing / metresPerPixel > 88 && spacing > min) spacing /= 2;
  return spacing;
}

const HATCH_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  // Reconstruct the actual terrain point, including the homogeneous divide.
  float depth = czm_unpackDepth(texture(czm_globeDepthTexture, gl_FragCoord.xy / czm_viewport.zw));
  vec4 eye = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
  vec3 ground = (czm_inverseView * (eye / eye.w)).xyz;
  if (czm_sceneMode != czm_sceneMode3D) {
    // Cesium's default GeographicProjection: world = (height, easting, northing).
    vec2 lonLat = ground.yz / 6378137.0;
    float s = sin(lonLat.y), c = cos(lonLat.y);
    float n = 6378137.0 / sqrt(1.0 - 0.00669437999014 * s * s);
    ground = vec3((n + ground.x) * c * cos(lonLat.x),
                  (n + ground.x) * c * sin(lonLat.x),
                  (n * (1.0 - 0.00669437999014) + ground.x) * s);
  }
  float diagonal = dot(ground - anchor, direction);
  float distanceToLine = abs(fract(diagonal / spacing + 0.5) - 0.5) * spacing;
  float footprint = max(length(vec2(dFdx(diagonal), dFdy(diagonal))), 0.001);
  float coverage = clamp((spacing * 0.01 + footprint * 0.5 - distanceToLine) / footprint, 0.0, 1.0);
  // Suppress unresolved far-horizon stripes instead of shimmering/moiré.
  coverage *= smoothstep(3.0, 8.0, spacing / footprint);
  material.diffuse = color.rgb;
  material.alpha = color.a * coverage;
  return material;
}`;

function openRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3 || ring.some(p => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null;
  const first = ring[0], last = ring.at(-1);
  const points = first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
  return points.length >= 3 ? points : null;
}

// The polygon rings of a feature, outer ring first, each as [lon, lat] pairs.
export function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

export function airspaceBoundaryOf(picked) {return picked?.id?.airspaceBoundary ?? null;}

// How wide a pick reaches, in pixels around the pointer. An aircraft a few
// kilometres away is a handful of pixels and it is moving, so a pick that only
// looked straight down the pointer missed far more often than it hit. This is
// about a fingertip's worth of slack, which is enough to catch what the pointer
// is plainly aimed at without reaching past it to something else.
export const PICK_SLACK_PX = 15;

// Drill when an airspace boundary or its faint interior covers a normal pick.
// Never route hatch polygons into picking: their transparent gaps would still
// participate in Cesium's geometry pick pass if allowPicking were enabled.
export function pickThroughAirspace(scene, position,
  picked = scene.pick(position, PICK_SLACK_PX, PICK_SLACK_PX)) {
  if (!airspaceBoundaryOf(picked)) return picked;
  return scene.drillPick(position, undefined, PICK_SLACK_PX, PICK_SLACK_PX)
    .find(hit => !airspaceBoundaryOf(hit)) ?? null;
}

export class AirspaceLayer {
  constructor(C, viewer) {
    this.C = C; this.scene = viewer.scene;
    this.collection = null; this.enabled = false;
    this.outline = null; this.hatches = []; this.credit = null;
    this.fill=null;
    this.hatchSpacing = null;
    this.shownKinds = new Set(Object.keys(KIND_STYLE));
  }
  color(css, alpha) {return this.C.Color.fromCssColorString(css).withAlpha(alpha);}
  styleOf(kind) {return KIND_STYLE[kind] ?? KIND_STYLE.other;}
  setPixelScale(metresPerPixel) {
    if (!(Number.isFinite(metresPerPixel) && metresPerPixel > 0)) return false;
    const next = hatchSpacingForScale(metresPerPixel, this.hatchSpacing);
    if (next === this.hatchSpacing) return false;
    this.hatchSpacing = next;
    for (const hatch of this.hatches) hatch.appearance.material.uniforms.spacing = next;
    return true;
  }
  // The collection to draw; drawn now if enabled, otherwise when it is.
  show(collection) {
    this.collection = collection ?? null;
    if (this.enabled) this.draw();
    return (this.collection?.features ?? []).length;
  }
  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return false;
    this.enabled = next;
    if (next) this.draw(); else this.clear();
    this.showCredit(next);
    return true;
  }
  // The licence asks for the source to be named while the data is on screen.
  showCredit(on) {
    const display = this.scene?.frameState?.creditDisplay;
    if (!display || !this.C.Credit) return;
    if (on && !this.credit) {this.credit = new this.C.Credit(CREDIT); display.addStaticCredit?.(this.credit);}
    else if (!on && this.credit) {display.removeStaticCredit?.(this.credit); this.credit = null;}
  }
  clear() {
    if(this.fill)this.scene.groundPrimitives.remove(this.fill);this.fill=null;
    if (this.outline) this.scene.groundPrimitives.remove(this.outline);
    for (const hatch of this.hatches) this.scene.groundPrimitives.remove(hatch);
    this.outline = null;
    this.hatches = [];
  }
  draw() {
    this.clear();
    const C = this.C, instances = [], fillInstances=[], hatchGroups = new Map();
    const hatchSupported = C.GroundPrimitive?.supportsMaterials(this.scene) === true;
    const positionsOf = points => C.Cartesian3.fromDegreesArray(points.flatMap(([lon, lat]) => [lon, lat]));
    for (const feature of this.collection?.features ?? []) {
      const props = feature.properties ?? {};
      if (HIDDEN_KINDS.has(props.kind) || !this.shownKinds.has(props.kind ?? 'other')) continue;
      const style = this.styleOf(props.kind);
      const angle = hatchAngleForFeature(feature), groupKey = `${style.color}:${angle}`;
      const boundary = {name: props.name || feature.id || style.label, kindLabel: props.kind_label || style.label,
        lower: props.lower ?? null, upper: props.upper ?? null};
      for (const rings of polygonsOf(feature.geometry)) {
        const clean = rings.map(openRing);
        // Fill and outline share metadata; foreground objects keep pick priority.
        for (const points of clean) {
          if (!points) continue;
          instances.push(new C.GeometryInstance({
            id: {airspaceBoundary: boundary},
            geometry: new C.GroundPolylineGeometry({
              positions: positionsOf(points),
              width: OUTLINE_WIDTH, loop: true, arcType: C.ArcType.GEODESIC,
            }),
            attributes: {color: C.ColorGeometryInstanceAttribute.fromColor(this.color(style.color, style.outline))},
          }));
        }
        if(clean.length&&clean.every(Boolean))fillInstances.push(new C.GeometryInstance({
          id:{airspaceBoundary:boundary},
          geometry:new C.PolygonGeometry({polygonHierarchy:new C.PolygonHierarchy(positionsOf(clean[0]),
            clean.slice(1).map(hole=>new C.PolygonHierarchy(positionsOf(hole)))),
            vertexFormat:C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT}),
          attributes:{color:C.ColorGeometryInstanceAttribute.fromColor(this.color(style.color,.07*style.outline))},
        }));
        // A malformed hole must never silently turn into hatched airspace.
        if (hatchSupported && clean.length && clean.every(Boolean)) {
          const group = hatchGroups.get(groupKey) ?? {style, direction: HATCH_DIRECTIONS.get(angle), instances: []};
          group.instances.push(new C.GeometryInstance({geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(positionsOf(clean[0]),
              clean.slice(1).map(hole => new C.PolygonHierarchy(positionsOf(hole)))),
            vertexFormat: C.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
          })}));
          hatchGroups.set(groupKey, group);
        }
      }
    }
    if(fillInstances.length)this.fill=this.scene.groundPrimitives.add(new C.GroundPrimitive({
      geometryInstances:fillInstances,appearance:new C.PerInstanceColorAppearance({flat:true,translucent:true}),
      allowPicking:true,classificationType:C.ClassificationType.TERRAIN,asynchronous:true,
    }));
    // Cesium 1.143 can queue missing 2D pick commands for material ground
    // primitives even with allowPicking=false. Keep this display-only layer
    // out of pick passes altogether, using the public primitive update hook.
    const AirspaceHatch = hatchSupported ? class extends C.GroundPrimitive {
      update(frameState) {if (!frameState.passes.pick && frameState.mode !== C.SceneMode.MORPHING) super.update(frameState);}
    } : null;
    for (const {style, direction, instances: geometryInstances} of hatchGroups.values()) {
      const material = new C.Material({fabric: {
        type: 'AeroDTAirspaceGroundHatch',
        uniforms: {color: this.color(style.color, .28 * style.outline), spacing: this.hatchSpacing ?? 4000,
          anchor: HATCH_ORIGIN, direction},
        source: HATCH_SOURCE,
      }, translucent: true});
      this.hatches.push(this.scene.groundPrimitives.add(new AirspaceHatch({
        geometryInstances, appearance: new C.MaterialAppearance({material, flat: true, translucent: true}),
        allowPicking: false, classificationType: C.ClassificationType.TERRAIN, asynchronous: true,
      })));
    }
    if (instances.length) this.outline = this.scene.groundPrimitives.add(new C.GroundPolylinePrimitive({
      geometryInstances: instances, appearance: new C.PolylineColorAppearance(),
      allowPicking: true, classificationType: C.ClassificationType.TERRAIN,
      asynchronous: true,
    }));
  }
  destroy() {this.clear(); this.showCredit(false); this.collection = null;}
}
