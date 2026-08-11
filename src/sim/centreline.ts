import * as THREE from "three";
import { nodeById, type LevelDef, type RoadDef } from "./types";

/**
 * Road centreline geometry, shared by the simulation and the renderer.
 *
 * A road with no waypoints is a two-point straight and every function here
 * reduces exactly to the straight-line arithmetic the network used to do
 * inline — same trim, same lateral offset — so existing levels are unchanged
 * to the bit. Waypoints turn the centreline into a Catmull-Rom spline sampled
 * uniformly by arc length, and lanes, kerbs, markings and tree rows all derive
 * from that one polyline.
 */

export type Pt = { x: number; z: number };

/** Sample spacing along a curved centreline, metres. */
const SAMPLE_STEP = 3.5;

const centrelineCache = new WeakMap<LevelDef, Map<string, Pt[]>>();

/**
 * The centreline of a road, oriented from `road.from` to `road.to`, node
 * centre to node centre. Straight roads stay two points.
 */
export function roadCentreline(level: LevelDef, road: RoadDef): Pt[] {
  let byRoad = centrelineCache.get(level);
  if (!byRoad) {
    byRoad = new Map();
    centrelineCache.set(level, byRoad);
  }
  const hit = byRoad.get(road.id);
  if (hit) return hit;

  const a = nodeById(level, road.from);
  const b = nodeById(level, road.to);

  let pts: Pt[];
  if (!road.waypoints || road.waypoints.length === 0) {
    pts = [
      { x: a.pos[0], z: a.pos[1] },
      { x: b.pos[0], z: b.pos[1] },
    ];
  } else {
    const control = [a.pos, ...road.waypoints, b.pos].map(
      ([x, z]) => new THREE.Vector3(x, 0, z),
    );
    // Centripetal parameterisation never kinks or overshoots between uneven
    // control spacings; spaced (not raw) points keep samples uniform in arc
    // length rather than bunching around the waypoints.
    const curve = new THREE.CatmullRomCurve3(control, false, "centripetal");
    const n = Math.max(8, Math.ceil(curve.getLength() / SAMPLE_STEP));
    pts = curve.getSpacedPoints(n).map((p) => ({ x: p.x, z: p.z }));
  }

  byRoad.set(road.id, pts);
  return pts;
}

export function reversePoly(poly: Pt[]): Pt[] {
  return [...poly].reverse();
}

export function polyLength(poly: Pt[]): number {
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    total += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
  }
  return total;
}

/** Cumulative arc length at each vertex; last entry is the total length. */
export function cumLengths(poly: Pt[]): number[] {
  const cum = new Array<number>(poly.length);
  cum[0] = 0;
  for (let i = 1; i < poly.length; i++) {
    cum[i] =
      cum[i - 1] +
      Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
  }
  return cum;
}

/** Position and unit tangent at arc distance s along the polyline. */
export function samplePoly(
  poly: Pt[],
  s: number,
): { x: number; z: number; tx: number; tz: number } {
  const cum = cumLengths(poly);
  const clamped = Math.max(0, Math.min(s, cum[cum.length - 1]));

  let i = 1;
  while (i < cum.length - 1 && cum[i] < clamped) i++;

  const segLen = cum[i] - cum[i - 1] || 1;
  const t = (clamped - cum[i - 1]) / segLen;
  const a = poly[i - 1];
  const b = poly[i];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;

  return {
    x: a.x + dx * t,
    z: a.z + dz * t,
    tx: dx / len,
    tz: dz / len,
  };
}

/** Unit tangent at one end, always pointing in the direction of travel. */
export function tangentAt(poly: Pt[], end: "start" | "end"): Pt {
  const [a, b] =
    end === "start"
      ? [poly[0], poly[1]]
      : [poly[poly.length - 2], poly[poly.length - 1]];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

/**
 * Cut `s0` off the start and `s1` off the end, measured in arc length. The new
 * endpoints are interpolated exactly, so trimming a straight by the junction
 * half-size lands on the same point the old inline arithmetic produced.
 */
export function trimPoly(poly: Pt[], s0: number, s1: number): Pt[] {
  const cum = cumLengths(poly);
  const total = cum[cum.length - 1];
  const from = Math.max(0, s0);
  const to = Math.min(total, total - s1);
  if (to - from < 1e-6) {
    throw new Error(`trimPoly: nothing left (length ${total}, trim ${s0}+${s1})`);
  }

  const unit = (i: number): Pt => {
    const dx = poly[i].x - poly[i - 1].x;
    const dz = poly[i].z - poly[i - 1].z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  };

  // The start point walks forward from its segment's tail, the end point walks
  // backward from its segment's head. On a two-point straight this reproduces
  // `node + u·trim` / `node − u·trim` to the bit, which keeps every existing
  // straight-road level's geometry untouched.
  let i = 1;
  while (i < cum.length - 1 && cum[i] < from) i++;
  const u0 = unit(i);
  const start: Pt = {
    x: poly[i - 1].x + u0.x * (from - cum[i - 1]),
    z: poly[i - 1].z + u0.z * (from - cum[i - 1]),
  };

  let j = cum.length - 1;
  while (j > 1 && cum[j - 1] > to) j--;
  const u1 = unit(j);
  const end: Pt = {
    x: poly[j].x - u1.x * (cum[j] - to),
    z: poly[j].z - u1.z * (cum[j] - to),
  };

  const out: Pt[] = [start];
  for (let k = 1; k < poly.length - 1; k++) {
    if (cum[k] > from + 1e-6 && cum[k] < to - 1e-6) out.push(poly[k]);
  }
  out.push(end);
  return out;
}

/**
 * Parallel curve at signed lateral distance `d` — positive is the driver's
 * right when travelling along the polyline. Interior vertices use a mitred
 * normal so the offset stays a constant distance from the centreline; the
 * miter is clamped at 2× so a (never expected) sharp kink cannot throw a
 * vertex to infinity.
 */
export function offsetPoly(poly: Pt[], d: number): Pt[] {
  const n = poly.length;
  const out = new Array<Pt>(n);

  // Right normal of the segment following vertex i.
  const segNormal = (i: number): Pt => {
    const a = poly[i];
    const b = poly[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: -(b.z - a.z) / len, z: (b.x - a.x) / len };
  };

  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      const nrm = segNormal(i === 0 ? 0 : n - 2);
      out[i] = { x: poly[i].x + nrm.x * d, z: poly[i].z + nrm.z * d };
      continue;
    }

    const n0 = segNormal(i - 1);
    const n1 = segNormal(i);
    let mx = n0.x + n1.x;
    let mz = n0.z + n1.z;
    const mlen = Math.hypot(mx, mz) || 1;
    mx /= mlen;
    mz /= mlen;

    // cos of half the turn angle: 1 when straight, →0 as the kink sharpens.
    const dot = n0.x * n1.x + n0.z * n1.z;
    const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2));
    const scale = d / Math.max(cosHalf, 0.5);
    out[i] = { x: poly[i].x + mx * scale, z: poly[i].z + mz * scale };
  }

  return out;
}

/**
 * Tightest turn radius along the polyline, from the discrete curvature at each
 * interior vertex. Infinity for a straight. An offset curve self-intersects
 * when this drops below the offset distance — validated at load, because on
 * screen the collapsed loop just looks like a slightly odd kerb.
 */
export function minTurnRadius(poly: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < poly.length - 1; i++) {
    const ax = poly[i].x - poly[i - 1].x;
    const az = poly[i].z - poly[i - 1].z;
    const bx = poly[i + 1].x - poly[i].x;
    const bz = poly[i + 1].z - poly[i].z;
    const la = Math.hypot(ax, az) || 1;
    const lb = Math.hypot(bx, bz) || 1;

    const cos = Math.min(1, Math.max(-1, (ax * bx + az * bz) / (la * lb)));
    const angle = Math.acos(cos);
    if (angle < 1e-4) continue;

    const chord = (la + lb) / 2;
    best = Math.min(best, chord / (2 * Math.sin(angle / 2)));
  }
  return best;
}

/** Total absolute turning along the polyline, radians. */
export function totalTurning(poly: Pt[]): number {
  let sum = 0;
  for (let i = 1; i < poly.length - 1; i++) {
    const ax = poly[i].x - poly[i - 1].x;
    const az = poly[i].z - poly[i - 1].z;
    const bx = poly[i + 1].x - poly[i].x;
    const bz = poly[i + 1].z - poly[i].z;
    const la = Math.hypot(ax, az) || 1;
    const lb = Math.hypot(bx, bz) || 1;
    const cos = Math.min(1, Math.max(-1, (ax * bx + az * bz) / (la * lb)));
    sum += Math.acos(cos);
  }
  return sum;
}

/** Shortest distance from a point to the polyline. */
export function distToPoly(x: number, z: number, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const ax = poly[i - 1].x;
    const az = poly[i - 1].z;
    const bx = poly[i].x;
    const bz = poly[i].z;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 === 0 ? 0 : ((x - ax) * dx + (z - az) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
    if (d < best) best = d;
  }
  return best;
}
