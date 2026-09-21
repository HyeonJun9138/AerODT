// Visualization: what colour the buildings are drawn.
//
// The geometry carries a neutral grey ramp baked in per feature - lighter for
// tall, darker for short - which reads as a city from above and as fog from
// street level. Grey is a safe default over dark satellite imagery, and it is
// also drab, so the operator gets a hue and a level to move it by.
//
// Both are applied as a multiply over the baked ramp rather than by rebuilding
// it. The ramp still says which building is tall; the tint says what the city
// is made of. A rebuild would mean re-extruding every footprint in view, which
// is seconds of work for a colour change that should be instant.
//
// Nothing here changes geometry, height or attribution. Presentation only.

// The hue is stored with its brightest channel at 1, so moving the level does
// not also change the colour and moving the colour does not also change the
// level. `#ffffff` is the neutral the layers were designed at.
export const TINTS = [
  {id: 'neutral', label: '중립 회색', css: '#ffffff'},
  {id: 'slate', label: '푸른 회색', css: '#c6dcff'},
  {id: 'sand', label: '모래', css: '#ffe2b8'},
  {id: 'warm', label: '따뜻한 석재', css: '#ffd2ad'},
  {id: 'teal', label: '청록', css: '#b6ffe8'},
  {id: 'violet', label: '보라', css: '#ddc9ff'},
  {id: 'ink', label: '짙은 청색', css: '#8fb2e0'},
];
export const DEFAULT_TINT = 'neutral';
// A multiplier on the baked ramp. Below about a third the city disappears into
// the imagery; above about 1.6 the tall bands clip to white and stop reading as
// heights at all.
export const BRIGHTNESS_RANGE = {min: 0.35, max: 1.6, step: 0.05, default: 1.0};
// How see-through the buildings are. The old floor was 0.35 because the layer
// assumed nobody would want less; an operator who wants a hint of a city rather
// than a city is entitled to ask for it.
export const OPACITY_RANGE = {min: 0.1, max: 1.0, step: 0.05, default: 0.9};

export function tintById(id) {return TINTS.find(item => item.id === id) ?? TINTS[0];}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// A hex colour as 0..1 red, green, blue, with the brightest channel pulled up
// to 1. Anything unreadable is the neutral, because a building layer that goes
// black over a bad setting is worse than one that ignores it.
export function tintRgb(id) {
  const found = /^#?([0-9a-f]{6})$/i.exec(String(tintById(id).css ?? '').trim());
  if (!found) return [1, 1, 1];
  const value = Number.parseInt(found[1], 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(item => item / 255);
  const peak = Math.max(...channels);
  return peak > 0 ? channels.map(item => item / peak) : [1, 1, 1];
}

export function normalizeBrightness(value, range = BRIGHTNESS_RANGE) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, range.min, range.max) : range.default;
}
export function normalizeOpacity(value, range = OPACITY_RANGE) {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, range.min, range.max) : range.default;
}

// Everything the layers need, from whatever the settings hold.
export function appearanceOf(values = {}) {
  return {
    tint: tintById(values.tint).id,
    rgb: tintRgb(values.tint),
    brightness: normalizeBrightness(values.brightness),
    opacity: normalizeOpacity(values.opacity),
  };
}

// One colour of the baked ramp, tinted and levelled, as a CSS hex. This is for
// the tileset providers, whose colours are a style rather than a shader: a
// 3D Tiles style is re-evaluated per feature on the GPU, so swapping the style
// is the cheap way to recolour one.
export function shade(css, {rgb = [1, 1, 1], brightness = 1} = {}) {
  const found = /^#?([0-9a-f]{6})$/i.exec(String(css ?? '').trim());
  if (!found) return css;
  const value = Number.parseInt(found[1], 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  const out = channels.map((item, index) => Math.round(clamp(item * rgb[index] * brightness, 0, 255)));
  return '#' + out.map(item => item.toString(16).padStart(2, '0')).join('');
}
