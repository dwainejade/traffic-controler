import type { LaneId, Network } from "./network";
import type { NodeId } from "./types";

/**
 * A point inside a junction where two movements cross, with the distance along
 * each connector at which the crossing happens.
 *
 * These are computed once at level load. Everything about junction safety is
 * derived from them: a phase is illegal if it contains two connectors that share
 * a conflict point, and a crash is two cars occupying one at the same moment.
 */
export type ConflictPoint = {
  a: LaneId;
  sA: number;
  b: LaneId;
  sB: number;
  x: number;
  z: number;
};

export type ConflictMap = {
  byJunction: Map<NodeId, ConflictPoint[]>;
  /** Fast lookup for phase legality: `${a}:${b}` with a < b. */
  pairs: Set<string>;
};

export function pairKey(a: LaneId, b: LaneId): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * How close two movement paths may come before they count as conflicting, when
 * they do not actually cross. Slightly wider than a car, so two vehicles at the
 * closest point would genuinely be touching.
 *
 * Two *separate* tests are needed and neither is sufficient alone:
 *
 *  - Proper intersection catches transversal crossings, the ordinary case.
 *  - Proximity catches paths that overlap while running antiparallel and never
 *    technically cross, which is what opposing left turns do on tight radii.
 *
 * Testing proximity between sampled vertices alone misses crossings outright: a
 * straight movement is stored as two points, so its mid-segment crossing with
 * another path is nowhere near either endpoint.
 */
export const CONFLICT_CLEARANCE = 2.6;

/** Proper intersection of segments p→p2 and q→q2, as fractions along each. */
function segmentCross(
  px: number, pz: number, p2x: number, p2z: number,
  qx: number, qz: number, q2x: number, q2z: number,
): { t: number; u: number; x: number; z: number } | null {
  const rx = p2x - px;
  const rz = p2z - pz;
  const sx = q2x - qx;
  const sz = q2z - qz;

  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return null; // parallel

  const t = ((qx - px) * sz - (qz - pz) * sx) / denom;
  const u = ((qx - px) * rz - (qz - pz) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return { t, u, x: px + rx * t, z: pz + rz * t };
}

/** Squared distance from point p to segment ab, plus where along ab it lands. */
function pointToSegment(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): { dist: number; t: number; x: number; z: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  const x = ax + dx * t;
  const z = az + dz * t;
  return { dist: Math.hypot(px - x, pz - z), t, x, z };
}

export function buildConflicts(net: Network): ConflictMap {
  const byJunction = new Map<NodeId, ConflictPoint[]>();
  const pairs = new Set<string>();

  for (const [junctionId, connectorIds] of net.connectorsByJunction) {
    const points: ConflictPoint[] = [];

    for (let i = 0; i < connectorIds.length; i++) {
      for (let k = i + 1; k < connectorIds.length; k++) {
        const a = net.lanes[connectorIds[i]];
        const b = net.lanes[connectorIds[k]];

        // Movements leaving the same lane diverge rather than cross, and
        // movements entering the same exit lane merge. Neither is a crossing
        // conflict, and both would otherwise register a false hit at the shared
        // endpoint.
        if (a.from !== null && a.from === b.from) continue;
        if (a.next[0] !== undefined && a.next[0] === b.next[0]) continue;

        let best: ConflictPoint | null = null;
        let bestDist = Infinity;

        // 1. Proper crossing. Decisive when present, so look for it first.
        for (let m = 0; m < a.cum.length - 1 && !best; m++) {
          for (let n = 0; n < b.cum.length - 1 && !best; n++) {
            const hit = segmentCross(
              a.pts[m * 2], a.pts[m * 2 + 1],
              a.pts[(m + 1) * 2], a.pts[(m + 1) * 2 + 1],
              b.pts[n * 2], b.pts[n * 2 + 1],
              b.pts[(n + 1) * 2], b.pts[(n + 1) * 2 + 1],
            );
            if (!hit) continue;

            bestDist = 0;
            best = {
              a: a.id,
              sA: a.cum[m] + (a.cum[m + 1] - a.cum[m]) * hit.t,
              b: b.id,
              sB: b.cum[n] + (b.cum[n + 1] - b.cum[n]) * hit.u,
              x: hit.x,
              z: hit.z,
            };
          }
        }

        // 2. No crossing — closest approach between the two paths, sampling A's
        // vertices against B's segments and vice versa so neither path's
        // resolution dominates.

        const consider = (
          from: typeof a, to: typeof b, flipped: boolean,
        ): void => {
          for (let m = 0; m < from.cum.length; m++) {
            const px = from.pts[m * 2];
            const pz = from.pts[m * 2 + 1];

            for (let n = 0; n < to.cum.length - 1; n++) {
              const hit = pointToSegment(
                px, pz,
                to.pts[n * 2], to.pts[n * 2 + 1],
                to.pts[(n + 1) * 2], to.pts[(n + 1) * 2 + 1],
              );
              if (hit.dist >= bestDist) continue;

              bestDist = hit.dist;
              const sFrom = from.cum[m];
              const sTo = to.cum[n] + (to.cum[n + 1] - to.cum[n]) * hit.t;
              // Ids stay fixed; only which walk produced which arc-length flips.
              best = {
                a: a.id,
                sA: flipped ? sTo : sFrom,
                b: b.id,
                sB: flipped ? sFrom : sTo,
                // Midway between the two paths at their closest approach.
                x: (px + hit.x) / 2,
                z: (pz + hit.z) / 2,
              };
            }
          }
        };

        if (!best) {
          consider(a, b, false);
          consider(b, a, true);
        }

        if (best && bestDist < CONFLICT_CLEARANCE) {
          points.push(best);
          pairs.add(pairKey(a.id, b.id));
        }
      }
    }

    byJunction.set(junctionId, points);
  }

  return { byJunction, pairs };
}

/**
 * A phase is legal exactly when no two of its movements cross. This is the one
 * rule behind the phase editor, the tutorial and the crash system.
 */
export function illegalPairsInPhase(
  conflicts: ConflictMap,
  connectors: LaneId[],
): [LaneId, LaneId][] {
  const bad: [LaneId, LaneId][] = [];
  for (let i = 0; i < connectors.length; i++) {
    for (let k = i + 1; k < connectors.length; k++) {
      if (conflicts.pairs.has(pairKey(connectors[i], connectors[k]))) {
        bad.push([connectors[i], connectors[k]]);
      }
    }
  }
  return bad;
}
