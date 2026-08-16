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

/**
 * How far the orthographic camera stands off the map.
 *
 * Fixed at 1200 until a map arrived that was bigger than the standoff. An ortho
 * camera still clips against its near plane, and the depth it measures runs
 * along the view axis — which at a 55° elevation picks up cos(55°) of every
 * horizontal metre. On a 5km card the near corner sits about 1980 units towards
 * the camera, i.e. 780 behind a camera standing at 1200, and the near half of
 * the city is simply cut away.
 */
export function orthoDistance(half: number): number {
  return Math.max(1200, half * 2.5);
}

/**
 * Far plane for either projection: past the furthest the player can pull back,
 * plus the depth of the card itself seen corner-on.
 *
 * This was a flat 6000, which is shorter than the distance the perspective
 * camera opens at on any map over about 1.6km across — so a 5km import framed
 * itself entirely beyond its own far plane and rendered a blank screen.
 */
export function farPlane(half: number): number {
  return Math.max(6000, (maxDistance(half) + half * Math.SQRT2) * 1.2);
}
