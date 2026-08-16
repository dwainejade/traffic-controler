import type { Lane, LaneId, Network } from "./network";
import type { LevelDef, NodeId } from "./types";

/**
 * How much map to simulate, in metres of radius around what the camera is
 * looking at. Three numbers, because one was not enough.
 *
 * The cost of a step is very close to linear in the area covered — measured on
 * a 25 km² grid, a step costs 0.37ms at 600m, 0.50ms at 1200m, 0.97ms at 2000m
 * and 1.49ms for the whole map. That last figure is the important one: at
 * ordinary speed a frame can afford to simulate *everything*, even at this size,
 * because 1.5ms sits comfortably inside a 16ms budget alongside a 4.4ms render.
 *
 * What cannot afford it is time-lapse. The player's multiplier is steps per
 * frame, so at 10x that same 1.5ms step becomes 15ms and the frame is gone. The
 * region therefore has to answer to the clock as well as the camera.
 *
 * `FLOOR` is the radius below which zooming *in* must never shrink it. Shrinking
 * retires every car outside the new region, so a region that tracked the view
 * downwards emptied the very streets the player had just zoomed in to look at.
 * Growing has no such problem — new streets are seeded to the density already
 * running — so the region follows the view outward freely and never inward.
 */
export const SIM_RADIUS_FLOOR = 1200;

/**
 * Ceiling at 1x. Chosen to cover the half-diagonal of the largest map the
 * importer can produce, so that at ordinary speed, zoomed out, the whole city
 * is running.
 */
export const SIM_RADIUS_MAX = 3600;

/** Floor under the budget rule, for absurd multipliers. */
export const SIM_RADIUS_MIN = 250;

/**
 * The radius to simulate, given what the camera sees and how fast time is
 * running.
 *
 * Cost is linear in area and so quadratic in radius, and the multiplier is a
 * straight factor on the number of steps per frame — so the radius that fits a
 * fixed budget falls as the square root of the speed. At 1x that leaves the
 * ceiling untouched; at 9x it is a third of it, which is about the floor.
 */
export function simRadiusFor(viewRadius: number, speed: number): number {
  const affordable = SIM_RADIUS_MAX / Math.sqrt(Math.max(1, speed));
  const wanted = Math.max(viewRadius, SIM_RADIUS_FLOOR);
  return Math.max(SIM_RADIUS_MIN, Math.min(wanted, affordable));
}

/**
 * Where everything in the network is, so the simulation can be confined to the
 * part of it somebody is looking at.
 *
 * The cost of a step is set by the size of the *network*, not by the traffic on
 * it: `drive` walks every lane twice whether or not a car is in it, the junction
 * loop ticks every signal, and the crash check visits every conflict point on
 * the map. Measured on a 25 km² grid — 2,135 junctions, 26,410 lanes, 410 cars —
 * those three came to 0.54ms, 0.47ms and 0.45ms of a 1.46ms step, and none of
 * them moved when the traffic did. Simulating a tenth of the map costs a tenth
 * as much, and on a map that large a tenth is still far more than fits on screen.
 *
 * This is the geometry that decision needs, computed once when the world is
 * built. Positions never change, so nothing here is ever recomputed.
 */
export type RegionIndex = {
  /** Lane bounding-sphere centres as flattened [x, z] pairs. */
  centre: Float32Array;
  /** Radius of each lane's bounding sphere about that centre. */
  radius: Float32Array;
  /** Junction position by node id. */
  junctionPos: Map<NodeId, { x: number; z: number }>;
  /**
   * Road lanes that feed each road lane, skipping over the connectors between
   * them.
   *
   * Needed to find the frontier: a lane on the edge of the simulated area is one
   * whose upstream neighbour is outside it, and that question cannot be asked of
   * `next` alone. Built here rather than in `Network` because this is the only
   * caller, and it is only worth the memory on a map big enough to be clipped.
   */
  incoming: Map<LaneId, LaneId[]>;
};

/** Lanes reachable in one movement from a road lane, via its connectors. */
function successors(net: Network, lane: Lane): LaneId[] {
  if (lane.kind === "connector") return lane.next;
  return lane.next
    .map((c) => net.lanes[c].next[0])
    .filter((id) => id !== undefined);
}

export function buildRegionIndex(level: LevelDef, net: Network): RegionIndex {
  const count = net.lanes.length;
  const centre = new Float32Array(count * 2);
  const radius = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const pts = net.lanes[i].pts;
    if (pts.length === 0) continue;

    /*
     * Midpoint of the extremes rather than the mean of the samples: a lane is
     * sampled more densely round a curve, so an average is pulled towards the
     * bend and the sphere it centres has to be larger to still contain the ends.
     */
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

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    centre[i * 2] = cx;
    centre[i * 2 + 1] = cz;
    radius[i] = Math.hypot(maxX - cx, maxZ - cz);
  }

  const junctionPos = new Map<NodeId, { x: number; z: number }>();
  for (const node of level.nodes) {
    if (node.kind === "junction") {
      junctionPos.set(node.id, { x: node.pos[0], z: node.pos[1] });
    }
  }

  const incoming = new Map<LaneId, LaneId[]>();
  for (const lane of net.lanes) {
    if (lane.kind !== "road") continue;
    for (const succ of successors(net, lane)) {
      const list = incoming.get(succ);
      if (list) list.push(lane.id);
      else incoming.set(succ, [lane.id]);
    }
  }

  return { centre, radius, junctionPos, incoming };
}
