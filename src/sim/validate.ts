import {
  distToPoly,
  minTurnRadius,
  polyLength,
  reversePoly,
  roadCentreline,
  totalTurning,
  trimPoly,
  type Pt,
} from "./centreline";
import { illegalPairsInPhase } from "./conflicts";
import { uncoveredMovements } from "./junction";
import { laneLateralOffset } from "./network";
import { junctionSize, nodeById, roadWidth, type LevelDef } from "./types";
import { World } from "./world";

/**
 * Numeric level validation.
 *
 * Every bad map this project has shipped looked completely fine on screen —
 * conflicts that never registered, movements no phase served, OD pairs that
 * quietly became unreachable. So maps are checked by assertion, not by eye.
 * Runs automatically in dev on level load, and from the console via
 * `SIMDEV.validateLevel(level)`.
 */

export type Validation = { id: string; errors: string[]; warnings: string[] };

const WARMUP = 35;
const RUN_SECONDS = 90;

export function validateLevel(level: LevelDef): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const world = new World(level);
  const net = world.net;

  // --- 1. No phase may contain a conflicting movement pair.
  for (const [id, junction] of world.junctions) {
    for (const phase of junction.phases) {
      const bad = illegalPairsInPhase(world.priority, phase.connectors);
      if (bad.length > 0) {
        errors.push(`junction ${id}: phase "${phase.name}" holds ${bad.length} conflicting pair(s)`);
      }
    }
    if (junction.phases.length === 0) {
      errors.push(`junction ${id}: no phases generated`);
    }

    // --- 2. Every movement is served by at least one phase.
    const stranded = uncoveredMovements(net, id, junction.phases);
    if (stranded.length > 0) {
      errors.push(`junction ${id}: ${stranded.length} movement(s) served by no phase`);
    }
  }

  // --- Structure: sources must both feed and drain, lanes must have somewhere to go.
  /*
   * A source normally both feeds and drains the map. The exception is real: at
   * the edge of an imported area a one-way couplet arrives on one street and
   * leaves on another, so the source on Rogers can only spawn and the one on
   * Nostrand can only drain. Neither is a fault — `entries` is built from spawn
   * lanes and `destinations` from exit lanes, so a one-directional source is
   * simply absent from the list it cannot serve, and the reachability check
   * below still covers every pair that actually exists.
   *
   * A source with neither is a genuine fault: it is connected to nothing.
   */
  for (const node of level.nodes) {
    if (node.kind !== "source") continue;
    const spawns = net.spawnLanes.filter((l) => net.lanes[l].fromNode === node.id);
    const exits = net.exitLanes.filter((l) => net.lanes[l].toNode === node.id);
    if (spawns.length === 0 && exits.length === 0) {
      errors.push(`source ${node.id}: neither spawns nor drains`);
    } else if (spawns.length === 0) {
      warnings.push(`source ${node.id}: drains only, never spawns (one-way in)`);
    } else if (exits.length === 0) {
      warnings.push(`source ${node.id}: spawns only, never drains (one-way out)`);
    }
  }
  for (const lane of net.lanes) {
    if (lane.kind === "road" && lane.junction !== null && lane.next.length === 0) {
      errors.push(`lane ${lane.id} (road ${lane.roadId}): feeds junction ${lane.junction} but has no movements`);
    }
  }

  // --- 3. Every origin can reach every destination.
  const entryNodes = [...new Set(net.spawnLanes.map((l) => net.lanes[l].fromNode))];
  for (const entry of entryNodes) {
    if (entry === null) continue;
    const lanes = net.spawnLanes.filter((l) => net.lanes[l].fromNode === entry);
    for (const dest of world.routing.destinations) {
      if (dest === entry) continue;
      const cost = world.routing.cost.get(dest);
      if (!cost || !lanes.some((l) => Number.isFinite(cost[l]))) {
        errors.push(`unreachable OD pair: ${entry} -> ${dest}`);
      }
    }
  }

  // --- 4. Lane geometry.
  const halfOf = (id: string | null) => {
    if (id === null) return 0;
    return nodeById(level, id).kind === "junction" ? junctionSize(level, id) / 2 : 0;
  };

  for (const lane of net.lanes) {
    // Monotonic arc length, all lanes including connectors.
    for (let i = 1; i < lane.cum.length; i++) {
      if (!(lane.cum[i] > lane.cum[i - 1])) {
        errors.push(`lane ${lane.id}: arc length not strictly increasing at vertex ${i}`);
        break;
      }
    }

    // Self-intersection, skipping adjacent segments.
    const pts: Pt[] = [];
    for (let i = 0; i < lane.pts.length / 2; i++) {
      pts.push({ x: lane.pts[i * 2], z: lane.pts[i * 2 + 1] });
    }
    if (selfIntersects(pts)) {
      errors.push(`lane ${lane.id} (${lane.kind}, road ${lane.roadId}): polyline self-intersects`);
    }

    if (lane.kind !== "road" || lane.roadId === null) continue;
    const road = level.roads.find((r) => r.id === lane.roadId);
    if (!road) continue;

    const centre = roadCentreline(level, road);
    const oriented = lane.fromNode === road.from ? centre : reversePoly(centre);
    const offset = Math.abs(laneLateralOffset(road, lane.index));

    // Every lane vertex sits at the lane's lateral offset from the centreline.
    for (const p of pts) {
      const d = distToPoly(p.x, p.z, oriented);
      if (Math.abs(d - offset) > 0.15) {
        errors.push(
          `lane ${lane.id} (road ${road.id}): vertex at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) ` +
            `is ${d.toFixed(2)}m from centreline, expected ${offset.toFixed(2)}m`,
        );
        break;
      }
    }

    // Lane length matches the trimmed centreline, allowing the systematic
    // inner/outer-curve difference d·theta an offset curve carries.
    const trimmed = trimPoly(oriented, halfOf(lane.fromNode), halfOf(lane.toNode));
    const centreLen = polyLength(trimmed);
    const tolerance = offset * totalTurning(trimmed) + 0.5;
    if (Math.abs(lane.length - centreLen) > tolerance) {
      errors.push(
        `lane ${lane.id} (road ${road.id}): length ${lane.length.toFixed(2)}m vs ` +
          `centreline ${centreLen.toFixed(2)}m (tolerance ${tolerance.toFixed(2)}m)`,
      );
    }

    // Trimmed ends should sit at the junction box, not inside it.
    for (const [nodeId, p] of [
      [lane.fromNode, pts[0]],
      [lane.toNode, pts[pts.length - 1]],
    ] as const) {
      const half = halfOf(nodeId);
      if (half === 0 || nodeId === null) continue;
      const node = nodeById(level, nodeId);
      const dist = Math.hypot(p.x - node.pos[0], p.z - node.pos[1]);
      if (dist < half * 0.85) {
        warnings.push(
          `lane ${lane.id} (road ${road.id}): end sits ${dist.toFixed(1)}m from ${nodeId}, ` +
            `well inside its ${half.toFixed(1)}m half-size box`,
        );
      }
    }
  }

  // Centreline curvature vs carriageway width: an offset tighter than the
  // radius folds the kerb back through itself.
  for (const road of level.roads) {
    const radius = minTurnRadius(roadCentreline(level, road));
    const needed = roadWidth(road) / 2 + 0.7 + 1;
    if (radius < needed) {
      errors.push(
        `road ${road.id}: min turn radius ${radius.toFixed(1)}m < ${needed.toFixed(1)}m needed for its width`,
      );
    }
  }

  // --- Zone polygons: parks are triangulated as THREE.Shape fills, so a
  // self-intersecting park is a rendering hazard, not just an aesthetic one.
  for (const zone of level.zones) {
    if (!zone.polygon) continue;
    if (zone.polygon.length < 3) {
      errors.push(`zone ${zone.id}: polygon has ${zone.polygon.length} points`);
      continue;
    }
    for (const [x, z] of zone.polygon) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        errors.push(`zone ${zone.id}: non-finite polygon vertex`);
        break;
      }
    }
    if (zone.kind === "park" && !polygonIsSimple(zone.polygon)) {
      errors.push(`zone ${zone.id}: park polygon self-intersects`);
    }
  }

  // --- 5. A run survives, and the car ledger balances.
  world.warmup(WARMUP);
  const sp0 = world.stats.spawned;
  const ret0 = world.stats.retired;
  const park0 = world.stats.parked;
  const act0 = world.stats.active;

  const steps = RUN_SECONDS * 60;
  for (let i = 0; i < steps; i++) world.step(1 / 60);

  if (world.state === "lost") {
    errors.push(`run: level ${world.failReason === "crash" ? "crashed" : "failed"} within ${RUN_SECONDS}s of warmup`);
  }
  /*
   * Every car created has to be somewhere: delivered off a map edge, towed after
   * a crash, sitting in a kerbside bay, or still driving. `spawned` counts cars
   * that pulled out of a bay as well as cars that arrived at an edge, so
   * unparking needs no term of its own — but parking does, because it is a way
   * off the map that did not exist before.
   */
  const spawned = world.stats.spawned - sp0;
  const balance =
    world.stats.delivered +
    (world.stats.retired - ret0) +
    (world.stats.parked - park0) +
    (world.stats.active - act0);
  if (spawned !== balance) {
    errors.push(
      `run: ledger off — spawned ${spawned} but delivered+retired+parked+Δactive = ${balance}`,
    );
  }
  if (spawned === 0 && world.demand > 0) {
    errors.push(`run: nothing spawned in ${RUN_SECONDS}s at demand ${world.demand}`);
  }

  // --- 6. Nothing non-finite anywhere.
  for (const lane of net.lanes) {
    for (let i = 0; i < lane.pts.length; i++) {
      if (!Number.isFinite(lane.pts[i])) {
        errors.push(`lane ${lane.id}: non-finite geometry`);
        break;
      }
    }
    if (!Number.isFinite(lane.length)) errors.push(`lane ${lane.id}: non-finite length`);
  }
  for (const car of world.cars) {
    if (!car.active) continue;
    if (!Number.isFinite(car.s) || !Number.isFinite(car.v) || !Number.isFinite(car.waited)) {
      errors.push(`car ${car.id}: non-finite state`);
    }
  }
  for (const [key, value] of Object.entries(world.stats)) {
    if (!Number.isFinite(value)) errors.push(`stats.${key}: non-finite`);
  }

  return { id: level.id, errors, warnings };
}

function polygonIsSimple(poly: [number, number][]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent around the loop
      const a = { x: poly[i][0], z: poly[i][1] };
      const b = { x: poly[(i + 1) % n][0], z: poly[(i + 1) % n][1] };
      const c = { x: poly[j][0], z: poly[j][1] };
      const d = { x: poly[(j + 1) % n][0], z: poly[(j + 1) % n][1] };
      if (segmentsCross(a, b, c, d)) return false;
    }
  }
  return true;
}

function selfIntersects(pts: Pt[]): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (segmentsCross(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
    }
  }
  return false;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return false;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / denom;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / denom;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
}

// ---------------------------------------------------------------- measurement

export type MeasureOptions = {
  level: LevelDef;
  /** Apply a signal plan to the fresh world before the run. */
  configure?: (world: World) => void;
  /** Scored run length after warmup. */
  seconds: number;
  /** Traffic seeds; the map is unchanged, only the arrival stream varies. */
  seeds?: number[];
};

export type MeasureResult = {
  seed: number;
  delayHours: number;
  delivered: number;
  spawned: number;
  active: number;
  meanWait: number;
};

/**
 * Headless A/B runner. Plan effects on this sim have historically been smaller
 * than seed noise on short runs (SNR 0.76 on one measured occasion), so any
 * claim that plan A beats plan B must come from paired seeds and runs long
 * enough for the effect to clear the noise — this is the tool for that.
 */
export function measure(opts: MeasureOptions): MeasureResult[] {
  const seeds = opts.seeds ?? [opts.level.seed];
  const results: MeasureResult[] = [];

  for (const seed of seeds) {
    const world = new World({ ...opts.level, seed });
    opts.configure?.(world);
    world.warmup(WARMUP);
    const sp0 = world.stats.spawned;

    const steps = Math.round(opts.seconds * 60);
    for (let i = 0; i < steps; i++) world.step(1 / 60);

    results.push({
      seed,
      delayHours: world.stats.delayHours,
      delivered: world.stats.delivered,
      spawned: world.stats.spawned - sp0,
      active: world.stats.active,
      meanWait: world.stats.meanWait,
    });
  }

  return results;
}
