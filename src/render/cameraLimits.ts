/**
 * The orbit camera's zoom/distance range, shared between `Controls` (which
 * enforces it) and anything else that needs to know where "fully zoomed in"
 * and "fully zoomed out" fall — depth of field, in particular, keys its
 * focus band off the same range so it agrees with what the player can
 * actually reach.
 */

/** Ortho zoom at the closest the player can get, on any level. */
export const MAX_ZOOM = 26;

/** Ortho zoom at the widest the player can pull back, framing the whole card. */
export function minZoom(half: number): number {
  return (370 / (half * Math.SQRT2)) * 0.85;
}

/** Perspective camera distance at the closest the player can get, on any level. */
export const MIN_DISTANCE = 70;

/** Perspective camera distance at the widest the player can pull back. */
export function maxDistance(half: number): number {
  return half * 4.5;
}
