import * as THREE from "three";
import {
  offsetPoly,
  reversePoly,
  roadCentreline,
  tangentAt,
  trimPoly,
  type Pt,
} from "./centreline";
import {
  LANE_WIDTH,
  STOP_OFFSET,
  junctionSize,
  nodeById,
  roadWidth,
  type LevelDef,
  type NodeId,
  type RoadDef,
} from "./types";

export type LaneId = number;

export type TurnKind = "left" | "straight" | "right";

/**
 * A lane is a polyline with cumulative arc lengths.
 *
 * A `road` lane spans the gap between two nodes — so on a grid, the lane joining
 * two junctions is a *single* lane that drains one and feeds the other. That is
 * what makes spillback fall out for free: when it fills, the upstream junction
 * has nowhere to put cars.
 *
 * Turning movements inside a junction are lanes too (`connector`). A car's route
 * is just an ordered list of lane ids, so turning needs no special-case code and
 * conflict detection becomes a geometry question about connector pairs.
 */
export type Lane = {
  id: LaneId;
  kind: "road" | "connector";
  /** Flattened [x, z] pairs. */
  pts: Float32Array;
  /** Cumulative distance at each point; last entry is the lane length. */
  cum: Float32Array;
  length: number;
  /**
   * Distance along the lane where a car must stop on a red. -1 when the lane
   * does not end at a signalised junction.
   */
  stopS: number;
  /** The junction this lane feeds into, if any. */
  junction: NodeId | null;
  /** Successor lanes: connectors for a road lane, the receiving lane for a connector. */
  next: LaneId[];
  /** Connectors only: the road lane this movement leaves from. */
  from: LaneId | null;
  /** Which turn a connector performs. */
  turn: TurnKind | null;
  /** Road lanes only. */
  roadId: string | null;
  /** Lane index outward from the centreline; 0 hugs the centre. */
  index: number;
  fromNode: NodeId | null;
  toNode: NodeId | null;
  /** Car ids currently on this lane, ordered front-most (largest s) first. */
  cars: number[];
};

export type Vec2 = { x: number; z: number };

/** One road meeting a junction, with the lanes and movements attached to it. */
export type Arm = {
  roadId: string;
  /** Unit vector pointing from the junction outward along this road. */
  out: Vec2;
  /** Lanes arriving at this junction on this road. */
  inbound: LaneId[];
  /** Lanes leaving this junction on this road. */
  outbound: LaneId[];
  /** Connectors that originate on this arm. */
  connectorIds: LaneId[];
};

export type Network = {
  lanes: Lane[];
  /** Lanes that begin at a map-edge source, where cars enter. */
  spawnLanes: LaneId[];
  /** Lanes that end at a map-edge source, where cars leave. */
  exitLanes: LaneId[];
  connectorsByJunction: Map<NodeId, LaneId[]>;
  armsByJunction: Map<NodeId, Arm[]>;
};

/** The driver's right-hand side for a given direction of travel. */
export function rightOf(d: Vec2): Vec2 {
  return { x: -d.z, z: d.x };
}

/**
 * Signed lateral offset of road lane `index` from the centreline, positive on
 * the driver's right. Two-way lanes sit wholly on the driver's side; a one-way
 * carriageway centres its lanes on the centreline instead. Shared with the
 * validation harness, which asserts every built lane actually sits at this
 * distance.
 */
export function laneLateralOffset(road: RoadDef, index: number): number {
  const off = LANE_WIDTH * (index + 0.5);
  return road.oneWay ? off - roadWidth(road) / 2 : off;
}

function polyline(points: Vec2[]): Pick<Lane, "pts" | "cum" | "length"> {
  const pts = new Float32Array(points.length * 2);
  const cum = new Float32Array(points.length);
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    pts[i * 2] = points[i].x;
    pts[i * 2 + 1] = points[i].z;
    if (i > 0) {
      total += Math.hypot(
        points[i].x - points[i - 1].x,
        points[i].z - points[i - 1].z,
      );
    }
    cum[i] = total;
  }
  return { pts, cum, length: total };
}

/** Position and heading at distance s along a lane. */
export function sampleLane(
  lane: Lane,
  s: number,
  out: { x: number; z: number; angle: number },
): void {
  const { cum, pts } = lane;
  const clamped = Math.max(0, Math.min(s, lane.length));

  let i = 1;
  while (i < cum.length - 1 && cum[i] < clamped) i++;

  const segLen = cum[i] - cum[i - 1] || 1;
  const t = (clamped - cum[i - 1]) / segLen;

  const ax = pts[(i - 1) * 2];
  const az = pts[(i - 1) * 2 + 1];
  const bx = pts[i * 2];
  const bz = pts[i * 2 + 1];

  out.x = ax + (bx - ax) * t;
  out.z = az + (bz - az) * t;
  out.angle = Math.atan2(bx - ax, bz - az);
}

/** Signed turn classification for traffic heading `from` and leaving along `to`. */
function classifyTurn(from: Vec2, to: Vec2): TurnKind | null {
  const dot = from.x * to.x + from.z * to.z;
  if (dot > 0.7) return "straight";
  if (dot < -0.7) return null; // U-turn: not modelled
  const cross = from.x * to.z - from.z * to.x;
  return cross < 0 ? "left" : "right";
}

export function buildNetwork(level: LevelDef): Network {
  const lanes: Lane[] = [];
  const addLane = (l: Omit<Lane, "id" | "cars">): Lane => {
    const lane: Lane = { ...l, id: lanes.length, cars: [] };
    lanes.push(lane);
    return lane;
  };

  const halfOf = (id: NodeId) =>
    nodeById(level, id).kind === "junction" ? junctionSize(level, id) / 2 : 0;

  // --- Road lanes, both directions of every road. Each direction's lanes are
  // lateral offsets of the road centreline, trimmed back to the junction boxes.
  // Trimming the *curve* by arc length keeps the setback constant however the
  // road bends between its ends.
  const trimmedByRoad = new Map<string, Pt[]>();

  for (const road of level.roads) {
    const a = nodeById(level, road.from);
    const b = nodeById(level, road.to);

    const centre = roadCentreline(level, road);
    const trimmed = trimPoly(centre, halfOf(a.id), halfOf(b.id));
    trimmedByRoad.set(road.id, trimmed);

    // A one-way road emits lanes for the from→to direction only; the reverse
    // simply never exists, and the graph downstream works over whatever is
    // there. Arms on it end up with only inbound or only outbound lanes.
    const directions = road.oneWay
      ? ([[a, b, trimmed]] as const)
      : ([
          [a, b, trimmed],
          [b, a, reversePoly(trimmed)],
        ] as const);

    for (const [start, end, poly] of directions) {
      for (let k = 0; k < road.lanesPerDir; k++) {
        const geom = polyline(offsetPoly(poly, laneLateralOffset(road, k)));

        const feedsJunction = end.kind === "junction";
        addLane({
          kind: "road",
          ...geom,
          stopS: feedsJunction ? geom.length - STOP_OFFSET : -1,
          junction: feedsJunction ? end.id : null,
          next: [],
          from: null,
          turn: null,
          roadId: road.id,
          index: k,
          fromNode: start.id,
          toNode: end.id,
        });
      }
    }
  }

  // --- Arms: group the lanes meeting each junction by road.
  const armsByJunction = new Map<NodeId, Arm[]>();
  for (const node of level.nodes) {
    if (node.kind !== "junction") continue;

    const arms: Arm[] = [];
    for (const road of level.roads) {
      if (road.from !== node.id && road.to !== node.id) continue;

      /*
       * The arm's outward direction is the road's *tangent* where it meets the
       * junction box, not the chord between node centres. On a curved road the
       * two diverge, and both turn classification and the compass naming read
       * this vector — a chord here would silently misclassify turns.
       */
      const trimmed = trimmedByRoad.get(road.id)!;
      const tangent =
        road.from === node.id
          ? tangentAt(trimmed, "start")
          : tangentAt(trimmed, "end");
      const sign = road.from === node.id ? 1 : -1;

      arms.push({
        roadId: road.id,
        out: { x: tangent.x * sign, z: tangent.z * sign },
        inbound: lanes
          .filter((l) => l.roadId === road.id && l.toNode === node.id)
          .sort((p, q) => p.index - q.index)
          .map((l) => l.id),
        outbound: lanes
          .filter((l) => l.roadId === road.id && l.fromNode === node.id)
          .sort((p, q) => p.index - q.index)
          .map((l) => l.id),
        connectorIds: [],
      });
    }
    armsByJunction.set(node.id, arms);
  }

  // --- Connectors: every legal movement across every junction.
  const connectorsByJunction = new Map<NodeId, LaneId[]>();

  for (const [junctionId, arms] of armsByJunction) {
    const ids: LaneId[] = [];

    for (const fromArm of arms) {
      const heading: Vec2 = { x: -fromArm.out.x, z: -fromArm.out.z };

      for (const toArm of arms) {
        if (toArm === fromArm) continue;
        const turn = classifyTurn(heading, toArm.out);
        if (!turn) continue;

        /*
         * Lane discipline. On a multi-lane approach the innermost lane is a
         * dedicated left-turn pocket: without it, one left-turner waiting for
         * its phase blocks every straight-ahead car queued behind it, which
         * collapses junction capacity.
         */
        const lastIdx = fromArm.inbound.length - 1;

        /*
         * Every movement holds its lane index: lane k in, lane k out.
         *
         * There is no lane-change model, so any pairing that moves a car
         * laterally has to do it inside the junction, and every such scheme
         * breaks something. Sending turns into any outbound lane makes opposing
         * left turns cross, costing an extra phase and its clearance. Letting
         * straight movements land anywhere makes lane 0→1 cross lane 1→0 within
         * a single approach — a weave — which costs another. Holding the lane
         * is the only pairing that stays conflict-free.
         *
         * The consequence is that a multi-lane approach partitions into
         * independent lanes, so these levels use one lane per direction, where
         * the question does not arise. Two-lane approaches need the real fix:
         * lane changing on the links.
         */
        const pairs: [number, number][] =
          turn === "left"
            ? [[0, 0]]
            : turn === "right"
              ? [[lastIdx, toArm.outbound.length - 1]]
              : fromArm.inbound.map(
                  (_, k) =>
                    [k, Math.min(k, toArm.outbound.length - 1)] as [number, number],
                );

        for (const [fromK, toK] of pairs) {
          const srcId = fromArm.inbound[fromK];
          const dstId = toArm.outbound[toK];
          if (srcId === undefined || dstId === undefined) continue;
          const src = lanes[srcId];
          const dst = lanes[dstId];

          const p0 = new THREE.Vector3(
            src.pts[src.pts.length - 2],
            0,
            src.pts[src.pts.length - 1],
          );
          const p1 = new THREE.Vector3(dst.pts[0], 0, dst.pts[1]);
          const gap = p0.distanceTo(p1);

          /*
           * Control-point distance for a bezier approximating a true circular
           * arc. A naive fraction of the chord overshoots and flattens opposing
           * left-turn paths onto the junction centre, where they run antiparallel
           * and pass through one another.
           */
          const turnAngle = Math.acos(
            THREE.MathUtils.clamp(
              heading.x * toArm.out.x + heading.z * toArm.out.z,
              -1,
              1,
            ),
          );
          const radius = gap / (2 * Math.sin(turnAngle / 2) || 1);
          const bend = (4 / 3) * Math.tan(turnAngle / 4) * radius;

          const curve = new THREE.CubicBezierCurve3(
            p0,
            new THREE.Vector3(p0.x + heading.x * bend, 0, p0.z + heading.z * bend),
            new THREE.Vector3(p1.x - toArm.out.x * bend, 0, p1.z - toArm.out.z * bend),
            p1,
          );

          // A straight movement between curved arms can join tangents that
          // differ by several degrees; two points would snap cars sideways.
          const samples = turn !== "straight" ? 14 : turnAngle > 0.05 ? 8 : 2;
          const pts = curve.getPoints(samples - 1).map((p) => ({ x: p.x, z: p.z }));

          const connector = addLane({
            kind: "connector",
            ...polyline(pts),
            stopS: -1,
            junction: junctionId,
            next: [dst.id],
            from: src.id,
            turn,
            roadId: null,
            index: fromK,
            fromNode: null,
            toNode: null,
          });

          src.next.push(connector.id);
          fromArm.connectorIds.push(connector.id);
          ids.push(connector.id);
        }
      }
    }

    connectorsByJunction.set(junctionId, ids);
  }

  const isSource = (id: NodeId | null) =>
    id !== null && nodeById(level, id).kind === "source";

  return {
    lanes,
    spawnLanes: lanes.filter((l) => l.kind === "road" && isSource(l.fromNode)).map((l) => l.id),
    exitLanes: lanes.filter((l) => l.kind === "road" && isSource(l.toNode)).map((l) => l.id),
    connectorsByJunction,
    armsByJunction,
  };
}
