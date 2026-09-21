// Shared presentation timing; no separate animation loop or scene state.
export const LABEL_FADE_MS = 900;
// The arrival is slower than an ordinary fade. Everything the opening flight
// held back appears at once when the camera settles, and 900 ms for a whole
// network at once reads as a switch rather than as something arriving.
export const ARRIVAL_FADE_MS = 2200;
export function labelFadeAlpha(elapsedMs, durationMs = LABEL_FADE_MS) {
  const t = Math.max(0, Math.min(1, elapsedMs / Math.max(1, durationMs)));
  return t * t * (3 - 2 * t);
}

// Fade before the hard distance limit, so zooming out does not cut text off.
export function labelDistanceAlpha(distance,near,far) {
  if(distance<near || distance>far)return 0;
  if(!Number.isFinite(far))return near>0?labelFadeAlpha((distance-near)/Math.max(1,near*.15)*LABEL_FADE_MS):1;
  const width=Math.max(1,(far-near)*.15);
  const inAlpha=near>0?labelFadeAlpha((distance-near)/width*LABEL_FADE_MS):1;
  return Math.min(inAlpha,labelFadeAlpha((far-distance)/width*LABEL_FADE_MS));
}
