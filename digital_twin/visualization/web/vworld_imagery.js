// V-World map tiles over Korea. The world imagery stays as the base layer and
// the chosen V-World layers sit directly above it, so the country is drawn from
// the national tiles and everything outside the service area still shows.
// Tiles come through the dashboard's own relay: the browser never holds the key.
export const KOREA = {west: 124.0, south: 32.8, east: 132.2, north: 39.2};
export const TILE_LEVELS = {minimum: 6, maximum: 19};
export const CREDIT = '국토교통부 브이월드';
export const BASE_SOURCE = 'world_imagery';
// Each display source is one or two V-World WMTS layers, bottom first.
export const VWORLD_SOURCES = {
  vworld_satellite: [['Satellite', 'jpeg']],
  vworld_hybrid: [['Satellite', 'jpeg'], ['Hybrid', 'png']],
  vworld_base: [['Base', 'png']],
  vworld_midnight: [['midnight', 'png']],
};

export function tileUrl(layer, extension) {
  return `/api/visualization/vworld/tiles/${layer}/{z}/{y}/{x}.${extension}`;
}

export function createProvider(C, layer, extension) {
  return new C.UrlTemplateImageryProvider({
    url: tileUrl(layer, extension),
    minimumLevel: TILE_LEVELS.minimum, maximumLevel: TILE_LEVELS.maximum,
    rectangle: C.Rectangle.fromDegrees(KOREA.west, KOREA.south, KOREA.east, KOREA.north),
    tilingScheme: new C.WebMercatorTilingScheme(),
    credit: new C.Credit(CREDIT), hasAlphaChannel: true,
  });
}

export class VWorldImagery {
  constructor(C, viewer, {style = () => {}} = {}) {
    Object.assign(this, {C, viewer, style});
    this.layers = []; this.source = BASE_SOURCE;
  }
  // Whether the base layer this sits on is there yet. Before it is, the choice
  // is only remembered; the base's own load applies it again.
  get ready() {return this.viewer.imageryLayers.length > 0;}
  apply(source, {force = false} = {}) {
    const wanted = VWORLD_SOURCES[source] ? source : BASE_SOURCE;
    if (!force && wanted === this.source) return false;
    this.source = wanted;
    this.remove();
    if (!this.ready) return true;
    const specs = VWORLD_SOURCES[wanted] ?? [];
    for (const [layer, extension] of specs) {
      const imagery = new this.C.ImageryLayer(createProvider(this.C, layer, extension));
      imagery.aerodtRole = 'vworld';
      this.style(imagery);
      // Just above the base and any V-World layer already placed; below the
      // place names and the clouds, which were added after the base.
      this.viewer.imageryLayers.add(imagery, Math.min(this.viewer.imageryLayers.length, 1 + this.layers.length));
      this.layers.push(imagery);
    }
    this.viewer.scene.requestRender();
    return true;
  }
  remove() {
    for (const layer of this.layers) this.viewer.imageryLayers.remove(layer, true);
    this.layers = [];
  }
  destroy() {this.remove();}
}
