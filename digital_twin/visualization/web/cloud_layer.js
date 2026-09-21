// Cloud imagery over the globe, from NASA GIBS. Two products serve two needs:
// a geostationary infrared view of East Asia that refreshes every ten minutes,
// and a daily global cloud-fraction composite. This layer only draws what it is
// told to; which product runs, how often and how strongly is decided elsewhere.
//
// GIBS EPSG:4326 is not a clean quad tree. Its levels run 2x1, 3x2, 5x3, 10x5,
// 20x10, 40x20: only from 10x5 does each level double, so a Cesium tiling
// scheme starts there and every request adds that offset back.
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';
const LEVEL_OFFSET = 3;
const BASE_TILES_X = 10;
const BASE_TILES_Y = 5;
const CREDIT = 'NASA EOSDIS GIBS';

// What a satellite in geostationary orbit can see. Asking for tiles outside it
// would fetch empty images for the far side of the world.
const HIMAWARI_DISK = {west: 78, south: -62, east: 180, north: 62};
// Cloud is the bright end of these images and the ground is the dark end, so
// every product is greyed, lifted away from its background and keyed at the
// dark end. That leaves cloud over a readable map instead of a colour wash.
const CLOUD_LOOK = {saturation: 0, contrast: 1.5, brightness: 1.08, alpha: .9, threshold: .56};

export const CLOUD_SOURCES = {
  // Infrared: cloud is cold and therefore bright, day and night.
  himawari_infrared: {
    id: 'himawari_infrared', label: 'Himawari 적외 (동아시아 · 10분 · 주야)',
    layer: 'Himawari_AHI_Band13_Clean_Infrared', matrixSet: '2km', format: 'png',
    gibsMaximumLevel: 5, cadence_seconds: 600, keyDark: true,
    coverage: HIMAWARI_DISK, display: {...CLOUD_LOOK},
  },
  // Visible light is crisper, but only where the sun is up, and it dims towards
  // dusk: a lower cut keeps thin cloud from disappearing with the sea.
  himawari_visible: {
    id: 'himawari_visible', label: 'Himawari 가시 (동아시아 · 10분 · 주간)',
    layer: 'Himawari_AHI_Band3_Red_Visible_1km', matrixSet: '1km', format: 'png',
    gibsMaximumLevel: 6, cadence_seconds: 600, keyDark: true,
    coverage: HIMAWARI_DISK, display: {...CLOUD_LOOK, contrast: 1.7, threshold: .34},
  },
  // A daily global composite: cloud fraction as a painted field, so it is laid
  // on more gently and covers the whole globe.
  modis: {
    id: 'modis', label: 'MODIS 구름량 (전 지구 · 일별)',
    layer: 'MODIS_Terra_Cloud_Fraction_Day', matrixSet: '2km', format: 'png',
    gibsMaximumLevel: 5, cadence_seconds: 21600, keyDark: true,
    display: {...CLOUD_LOOK, contrast: 1.25, alpha: .7, threshold: .4},
  },
};
const DEFAULT_SOURCE = 'himawari_infrared';

export function tilingFor(source) {
  return {
    numberOfLevelZeroTilesX: BASE_TILES_X,
    numberOfLevelZeroTilesY: BASE_TILES_Y,
    levelOffset: LEVEL_OFFSET,
    maximumLevel: source.gibsMaximumLevel - LEVEL_OFFSET,
  };
}

export function gibsTileUrl(source, {level, x, y, time}) {
  const at = time || 'default';
  return `${GIBS}/${source.layer}/default/${at}/${source.matrixSet}/${level + LEVEL_OFFSET}/${y}/${x}.${source.format}`;
}

// GIBS publishes a slot some minutes after it exists, so a timestamp computed
// here can be a 404. The layer default always resolves to the newest published
// image; this version only has to change when a new one can exist, so tiles
// stay cacheable inside a window.
export function versionFor(source, now = Date.now()) {
  const step = Math.max(1, source.cadence_seconds) * 1000;
  return String(Math.floor(now / step));
}

export class CloudLayer {
  constructor(C, viewer, {now = () => Date.now()} = {}) {
    this.C = C; this.viewer = viewer; this.now = now;
    this.layer = null; this.shownKey = null;
    this.settings = {enabled: false, source: DEFAULT_SOURCE, opacity: CLOUD_LOOK.alpha};
  }
  // `settings` is {enabled, source, opacity}. Nothing is requested while it is off.
  apply(settings = {}) {
    const wanted = {...this.settings, ...settings};
    this.settings = wanted;
    const source = CLOUD_SOURCES[wanted.source] ?? CLOUD_SOURCES[DEFAULT_SOURCE];
    if (!wanted.enabled) {this.remove(); return;}
    const key = `${source.id}|${versionFor(source, this.now())}`;
    if (this.layer && key === this.shownKey) {this.layer.alpha = wanted.opacity; this.viewer.scene.requestRender(); return;}
    this.place(source, key, wanted.opacity);
  }
  // A ten minute product goes stale; re-placing it asks for the newest slot.
  refresh() {
    if (!this.layer) return;
    const source = CLOUD_SOURCES[this.settings.source] ?? CLOUD_SOURCES[DEFAULT_SOURCE];
    this.place(source, `${source.id}|${versionFor(source, this.now())}`, this.settings.opacity);
  }
  place(source, key, opacity) {
    const C = this.C, tiling = tilingFor(source);
    const version = versionFor(source, this.now());
    const provider = new C.UrlTemplateImageryProvider({
      url: gibsTileUrl(source, {level: 0, x: 0, y: 0}).replace('/3/0/0.', '/{gibsLevel}/{reverseY}/{x}.') + `?v=${version}`,
      tilingScheme: new C.GeographicTilingScheme({numberOfLevelZeroTilesX: tiling.numberOfLevelZeroTilesX,
        numberOfLevelZeroTilesY: tiling.numberOfLevelZeroTilesY}),
      tileWidth: 512, tileHeight: 512, maximumLevel: tiling.maximumLevel,
      customTags: {gibsLevel: (_provider, _x, _y, level) => level + LEVEL_OFFSET,
        reverseY: (_provider, _x, y) => y},
      ...(source.coverage ? {rectangle: C.Rectangle.fromDegrees(source.coverage.west, source.coverage.south,
        source.coverage.east, source.coverage.north)} : {}),
      credit: new C.Credit(CREDIT),
    });
    const look = source.display ?? CLOUD_LOOK;
    const layer = new C.ImageryLayer(provider, {
      alpha: opacity,
      saturation: look.saturation, contrast: look.contrast, brightness: look.brightness,
      // Grey first, then drop the dark end: what is left is cloud over a map
      // that can still be read, rather than a wash across everything.
      ...(source.keyDark ? {colorToAlpha: C.Color.BLACK, colorToAlphaThreshold: look.threshold} : {}),
    });
    this.remove();
    this.viewer.imageryLayers.add(layer);
    this.viewer.imageryLayers.raiseToTop?.(layer);
    this.layer = layer; this.shownKey = key;
    this.viewer.scene.requestRender();
  }
  remove() {
    if (!this.layer) return;
    this.viewer.imageryLayers.remove(this.layer);
    this.layer = null; this.shownKey = null;
    this.viewer.scene.requestRender();
  }
  destroy() {this.remove();}
}
