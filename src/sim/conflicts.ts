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

    /*
     * Bounding box of every connector through this junction, so pairs that
     * cannot possibly conflict are thrown out before any geometry runs.
     *
     * Exactly equivalent rather than approximate: a pair only survives below if
     * its closest approach comes within `CONFLICT_CLEARANCE`, and two paths
     * whose boxes are further apart than that cannot get closer than that. A
     * junction's connectors are mostly nowhere near each other — the two right
     * turns on opposite corners never meet — and each surviving pair otherwise
     * costs a segment-by-segment crossing test followed by two closest-approach
     * walks.
     */
    const boxes = connectorIds.map((id) => {
      const pts = net.lanes[id].pts;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let p = 0; p < pts.length; p += 2) {
        if (pts[p] < minX) minX = pts[p];
        if (pts[p] > maxX) maxX = pts[p];
        if (pts[p + 1] < minZ) minZ = pts[p + 1];
        if (pts[p + 1] > maxZ) maxZ = pts[p + 1];
      }
      return { minX, maxX, minZ, maxZ };
    });

    for (let i = 0; i < connectorIds.length; i++) {
      for (let k = i + 1; k < connectorIds.length; k++) {
        const ba = boxes[i];
        const bb = boxes[k];
        if (
          ba.minX - bb.maxX > CONFLICT_CLEARANCE ||
          bb.minX - ba.maxX > CONFLICT_CLEARANCE ||
          ba.minZ - bb.maxZ > CONFLICT_CLEARANCE ||
          bb.minZ - ba.maxZ > CONFLICT_CLEARANCE
        ) {
          continue;
        }

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
 * A phase is legal exactly when no two of its movements *hard*-conflict.
 * Crossings a driver can yield out of — a permissive left against oncoming —
 * are legal in one phase and are resolved on the road instead.
 */
export function illegalPairsInPhase(
  priority: Priority,
  connectors: LaneId[],
): [LaneId, LaneId][] {
  const bad: [LaneId, LaneId][] = [];
  for (let i = 0; i < connectors.length; i++) {
    for (let k = i + 1; k < connectors.length; k++) {
      if (priority.hard.has(pairKey(connectors[i], connectors[k]))) {
        bad.push([connectors[i], connectors[k]]);
      }
    }
  }
  return bad;
}

// ------------------------------------------------------------------ priority

/**
 * Who gives way to whom inside the box.
 *
 * Two movements crossing does not, on its own, mean they cannot run together.
 * On a New York green ball, an approach gets *all* of its movements at once —
 * straight, left and right — and the left turn crosses oncoming traffic and
 * yields to it. That is how a normal signal works, and it is why a standard
 * crossroads runs two phases rather than four: north and south together, then
 * east and west.
 *
 * So each crossing pair is one of three things:
 *
 *   - **soft** — a permissive left against oncoming traffic. Legal together;
 *     the left turn waits for a gap.
 *   - **none** — two opposing left turns. They pass each other driver's side to
 *     driver's side and never actually meet, but on a tight radius their
 *     modelled paths come within the clearance and register as a conflict.
 *   - **hard** — anything else. These genuinely cannot be green together.
 */
export type YieldTarget = {
  /** The movement to give way to. */
  connector: LaneId;
  /** Where along that movement the two paths meet. */
  sAt: number;
  /** Where along *this* movement they meet — how far a waiting car may creep. */
  sSelf: number;
  /** The road lane feeding it, so approaching traffic counts too. */
  feeder: LaneId | null;
};

export type Priority = {
  /** Pairs that may never be green together. A subset of `ConflictMap.pairs`. */
  hard: Set<string>;
  /** Per connector, the movements it must give way to. */
  yieldTo: Map<LaneId, YieldTarget[]>;
};

/** Arms this far from head-on count as opposing. cos(126°). */
const OPPOSING = -0.59;

export function buildPriority(net: Network, conflicts: ConflictMap): Priority {
  const hard = new Set<string>();
  const yieldTo = new Map<LaneId, YieldTarget[]>();

  // Outward direction of the arm each connector leaves from, so "oncoming" can
  // be decided by geometry rather than by compass names.
  const armOut = new Map<LaneId, { x: number; z: number }>();
  for (const [junctionId, arms] of net.armsByJunction) {
    void junctionId;
    for (const arm of arms) {
      for (const id of arm.connectorIds) armOut.set(id, arm.out);
    }
  }

  const add = (from: LaneId, target: YieldTarget) => {
    const list = yieldTo.get(from) ?? [];
    list.push(target);
    yieldTo.set(from, list);
  };

  for (const points of conflicts.byJunction.values()) {
    for (const point of points) {
      const a = net.lanes[point.a];
      const b = net.lanes[point.b];
      const outA = armOut.get(a.id);
      const outB = armOut.get(b.id);

      const opposing =
        outA !== undefined &&
        outB !== undefined &&
        outA.x * outB.x + outA.z * outB.z < OPPOSING;

      const leftA = a.turn === "left";
      const leftB = b.turn === "left";

      if (opposing && leftA && leftB) continue; // they pass; nothing to resolve

      /*
       * A turn out of the general lanes crossing the bus lane beside it.
       *
       * The two movements leave the *same* arm, which no other conflicting pair
       * does: normally lane discipline keeps an approach's movements parallel
       * all the way through the box. A kerbside bus lane breaks that, because
       * anything turning toward that kerb has to cross it.
       *
       * This is emphatically not a reason to give the bus lane its own phase.
       * On a real street the turning driver looks over their shoulder, waits for
       * the bus, and goes — and signalising it instead would cost the junction a
       * whole clearance interval a cycle to separate two movements that already
       * separate themselves. So: the turn gives way, the bus does not.
       */
      if (outA !== undefined && outA === outB) {
        const busStraight = (l: typeof a) => l.turn === "straight" && l.access === "bus";
        if (busStraight(a) && b.turn !== "straight") {
          add(b.id, { connector: a.id, sAt: point.sA, sSelf: point.sB, feeder: a.from });
          continue;
        }
        if (busStraight(b) && a.turn !== "straight") {
          add(a.id, { connector: b.id, sAt: point.sB, sSelf: point.sA, feeder: b.from });
          continue;
        }
      }

      if (opposing && leftA !== leftB) {
        // The left turn waits; the movement coming the other way does not.
        if (leftA) {
          add(a.id, { connector: b.id, sAt: point.sB, sSelf: point.sA, feeder: b.from });
        } else {
          add(b.id, { connector: a.id, sAt: point.sA, sSelf: point.sB, feeder: a.from });
        }
        continue;
      }

      hard.add(pairKey(a.id, b.id));
    }
  }

  return { hard, yieldTo };
}
