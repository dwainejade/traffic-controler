import { mulberry32 } from "../render/geometry";

/**
 * The island the city stands on.
 *
 * Manhattan is the reference: a long, narrow landmass whose grid is turned
 * about 29° off true north, so its "avenues" run the length of the island and
 * its "streets" cross it. What makes it read as a real place from above is not
 * the grid at all — it is that the water edge ignores the grid completely, so
 * the blocks along the shore are cut off at angles the grid never chose.
 *
 * The outline is an ellipse with a few low-frequency harmonics added to its
 * radius, which gives bays and points without any hand-authoring. Amplitudes
 * are kept small enough in total that the curve cannot fold back through
 * itself — the shoreline is used for point-in-polygon tests and as an extruded
 * mesh, and both go wrong on a self-intersecting loop.
 */

export type Poly = [number, number][];

export type IslandOptions = {
  seed: number;
  /** Half-length along the island's long axis, metres. */
  longHalf: number;
  /** Half-width across it. Manhattan is about 6:1; 2.5:1 reads better on screen. */
  shortHalf: number;
  /** Rotation of the whole island, radians. Manhattan's grid sits ~29° off north. */
  angle: number;
  /**
   * How much narrower the island gets toward one end, 0..1. Manhattan is broad
   * across Harlem and the Upper West Side and tapers to a point at the Battery,
   * and that asymmetry does a lot of the work of not looking generated — a
   * symmetric blob reads as a blob whichever way you turn it.
   */
  taper?: number;
  /** Points around the loop. */
  segments?: number;
};

export function islandShoreline(opts: IslandOptions): Poly {
  const { seed, longHalf, shortHalf, angle } = opts;
  const segments = opts.segments ?? 128;
  const rand = mulberry32(seed ^ 0x5eed1a);

  /*
   * Harmonics 2..5, kept deliberately small. Total amplitude stays well under
   * 0.3 so the radius never approaches zero and the loop stays simple — but
   * the tighter reason is that the street grid is symmetric and cannot follow a
   * shoreline that bulges hard to one side, so a big lobe just becomes bare
   * land with nothing built on it. Enough wobble to read as a coast, not enough
   * to outrun the grid.
   */
  const harmonics = [2, 3, 4, 5].map((k) => ({
    k,
    amp: (0.075 / (k - 1)) * (0.55 + rand() * 0.9),
    phase: rand() * Math.PI * 2,
  }));

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pts: Poly = [];

  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;

    let r = 1;
    for (const h of harmonics) r += h.amp * Math.sin(h.k * t + h.phase);

    /*
     * Local coordinates: long axis along z, so the island stands "tall" before
     * the rotation turns it.
     *
     * A plain ellipse tapers to points at both ends, and a street grid cannot
     * use a point — every junction there fails the shoreline margin, so the
     * tips come out as bare land with nothing on them. A superellipse keeps the
     * ends blunt enough to hold blocks, which is also closer to the real thing:
     * Manhattan's southern end is a broad flat toe, not a spike.
     */
    const P = 2.7;
    const soften = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 2 / P);
    const lz = soften(Math.sin(t)) * longHalf * r;

    /*
     * Taper the width by position along the long axis: full width at the
     * northern end, pinched to a point at the southern one. `u` runs 0 at the
     * north tip to 1 at the south tip.
     */
    const taper = opts.taper ?? 0;
    const u = (lz / longHalf + 1) / 2;
    const width = 1 - taper * Math.pow(Math.max(0, Math.min(1, u)), 1.7);
    const lx = soften(Math.cos(t)) * shortHalf * r * width;

    pts.push([lx * cos - lz * sin, lx * sin + lz * cos]);
  }

  return pts;
}

/**
 * The water: the island's own outline pushed outward, so the rivers keep a
 * constant width all the way round and the far bank is simply everything beyond.
 *
 * The alternative — modelling the far banks as their own slabs at a fixed
 * distance from the centre — looks wrong the moment the island tapers, because
 * the gap between shore and bank then widens as the island narrows, and the
 * bridges at the narrow end come out longer than the island is wide. Offsetting
 * the shoreline keeps every crossing the same short span, which is what a river
 * of constant width gives you.
 *
 * `wobble` varies the width a little so the two banks are not perfect
 * parallels, and is kept small enough that the offset curve cannot fold back on
 * itself against the island's own curvature.
 */
export function waterOutline(poly: Poly, channel: number, seed: number): Poly {
  const rand = mulberry32(seed ^ 0xba5e1a);
  const phase = rand() * Math.PI * 2;
  const n = poly.length;
  const out: Poly = [];

  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const next = poly[(i + 1) % n];

    // Outward normal, from the average direction of the two adjacent edges.
    const tx = next[0] - prev[0];
    const tz = next[1] - prev[1];
    const len = Math.hypot(tx, tz) || 1;
    const nx = tz / len;
    const nz = -tx / len;

    const t = (i / n) * Math.PI * 2;
    const width =
      channel * (1 + 0.22 * Math.sin(t * 2 + phase) + 0.1 * Math.sin(t * 3 - phase));

    out.push([poly[i][0] + nx * width, poly[i][1] + nz * width]);
  }

  // The shoreline is generated clockwise or anticlockwise depending on the
  // harmonics; if the offset came out smaller, the normal pointed inward.
  return Math.abs(shoelace(out)) < Math.abs(shoelace(poly))
    ? poly.map((p, i) => {
        const prev = poly[(i - 1 + n) % n];
        const next = poly[(i + 1) % n];
        const tx = next[0] - prev[0];
        const tz = next[1] - prev[1];
        const len = Math.hypot(tx, tz) || 1;
        return [p[0] - (tz / len) * channel, p[1] + (tx / len) * channel] as [number, number];
      })
    : out;
}

function shoelace(poly: Poly): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i];
    const [x1, z1] = poly[(i + 1) % poly.length];
    s += x0 * z1 - x1 * z0;
  }
  return s / 2;
}

/** Even-odd point-in-polygon on the ground plane. */
export function pointInPolygon(x: number, z: number, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from a point to the polygon's boundary. */
export function distToPolygon(x: number, z: number, poly: Poly): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j];
    const [bx, bz] = poly[i];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 === 0 ? 0 : ((x - ax) * dx + (z - az) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}

/**
 * True when the point is on land and at least `margin` clear of the water —
 * the test that decides which junctions of the grid survive.
 */
export function wellInside(x: number, z: number, poly: Poly, margin: number): boolean {
  return pointInPolygon(x, z, poly) && distToPolygon(x, z, poly) >= margin;
}
