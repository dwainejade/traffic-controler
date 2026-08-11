/**
 * Draw order for everything flat on the ground plane.
 *
 * All of this is coplanar in spirit — kerb, asphalt, bus lane, junction box,
 * queue tint, paint, stop bars — and the only thing keeping it from tearing is
 * a small vertical offset per layer. Those offsets used to be a millimetre or
 * two apart, which is far less than it sounds: under the perspective camera the
 * depth buffer is nonlinear and its resolution out at the far side of a
 * six-hundred-metre map is coarse enough that a 1mm gap rounds to nothing, and
 * two layers swap places from frame to frame as the camera moves.
 *
 * A 25mm step is imperceptible at this viewing angle — the whole ladder is a
 * finger's width — and gives every layer a clear margin at any zoom on any map.
 *
 * Keep them here rather than beside each mesh. Scattered across five components
 * they drifted into collisions twice: the parking line was written at exactly
 * `Y_MARK`, coplanar with the markings it was meant to sit beside.
 */

const STEP = 0.025;
const at = (n: number) => +(STEP * n).toFixed(4);

export const LAYER = {
  /** Parks and grass: painted on the card, under the streets that cross them. */
  green: at(1),
  /** Kerb lip, under everything on the street side. */
  curb: at(2),
  junctionCurb: at(3),
  /** The carriageway itself. */
  road: at(4),
  busLane: at(5),
  /** Junction boxes, which cover the road ends tucked beneath them. */
  junction: at(6),
  /** Congestion tint — over the surface, under the paint. */
  pressure: at(7),
  /** Bus stop boxes. */
  stopBox: at(8),
  /** Paint: parking lines, then lane markings over them. */
  parkingLine: at(9),
  marking: at(10),
  /** Headlight pools on the road. */
  beam: at(11),
  /** Contact shadows, which belong over the paint a vehicle stands on. */
  shadow: at(12),
  /** Signal stop bars — the brightest thing down here, and always on top. */
  stopBar: at(13),
} as const;
