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
  /**
   * Who may drive here.
   *
   * A bus lane was, until now, paint: real width that widened the street and
   * carried nothing. It is a lane, and the reason it is worth simulating is that
   * it is a lane *general traffic cannot use* — the capacity it removes from the
   * cars is exactly as real as the capacity it gives the buses, and a bus lane
   * that anyone could drive in would be neither.
   */
  access: "all" | "bus";
  fromNode: NodeId | null;
  toNode: NodeId | null;
  /**
   * The sibling lane one step toward the centreline, and one step toward the
   * kerb. Road lanes only; `null` at either edge of the carriageway.
   *
   * Precomputed because the alternative is a scan over every lane in the network
   * to answer "what is beside me", asked by every car on every step. `index`
   * counts outward from the centreline, so `left` is `index - 1`.
   *
   * These say only that a lane is *adjacent*, never that a change into it is
   * allowed: the bus lane is somebody's `right`, and general traffic may not go
   * there. `access` is checked at the point of use.
   */
  left: LaneId | null;
  right: LaneId | null;
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

/** Shortest-path interpolation from angle `a` to `b`, at fraction `t`. */
function angleLerp(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  const diff = (((b - a + Math.PI) % twoPi) + twoPi) % twoPi - Math.PI;
  return a + diff * t;
}

/**
 * Heading at polyline vertex `j`, blended from its neighbouring segments
 * (a centred difference) rather than taken from just one of them. An interior
 * vertex is the corner between two segments with different constant
 * headings; using the neighbour on both sides gives each vertex a single
 * heading that the segments on either side can be interpolated toward,
 * instead of each vertex belonging to whichever segment is sampled.
 */
function vertexHeading(pts: Float32Array, n: number, j: number): number {
  if (j <= 0) {
    return Math.atan2(pts[2] - pts[0], pts[3] - pts[1]);
  }
  if (j >= n - 1) {
    const last = n - 1;
    return Math.atan2(
      pts[last * 2] - pts[(last - 1) * 2],
      pts[last * 2 + 1] - pts[(last - 1) * 2 + 1],
    );
  }
  return Math.atan2(
    pts[(j + 1) * 2] - pts[(j - 1) * 2],
    pts[(j + 1) * 2 + 1] - pts[(j - 1) * 2 + 1],
  );
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

  /*
   * The polyline's true heading is constant per segment and steps at every
   * vertex — accurate, but a car can spend many frames crossing one segment
   * at low playback speed and then snap to the next, reading as a stutter
   * rather than a turn. Interpolating between each segment's *blended*
   * vertex headings keeps the heading turning continuously through the
   * corner instead of stepping at it, without moving the path itself.
   */
  const n = cum.length;
  out.angle = angleLerp(
    vertexHeading(pts, n, i - 1),
    vertexHeading(pts, n, i),
    t,
  );
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
  const addLane = (l: Omit<Lane, "id" | "cars" | "left" | "right">): Lane => {
    const lane: Lane = { ...l, id: lanes.length, cars: [], left: null, right: null };
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
      /*
       * A bus lane, where this direction has one, is emitted as one more lane at
       * index `lanesPerDir` — immediately outboard of the general lanes and
       * inboard of the parking, which is precisely where `roadEdges` paints it.
       *
       * No new offset arithmetic is needed for this, and that is not luck:
       * `laneLateralOffset(road, lanesPerDir)` already lands on the middle of
       * the painted strip, for a one-way and a two-way alike, because both
       * stack their extras outward from the same edge in the same order.
       */
      const forward = start.id === road.from;
      const busLanes = road.busLanes ?? {};
      const busHere = road.oneWay
        ? (busLanes.forward ?? 0)
        : ((forward ? busLanes.forward : busLanes.backward) ?? 0);
      const count = road.lanesPerDir + (busHere > 0 ? 1 : 0);

      for (let k = 0; k < count; k++) {
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
          access: k >= road.lanesPerDir ? "bus" : "all",
          fromNode: start.id,
          toNode: end.id,
        });
      }
    }
  }

  /*
   * --- Lane adjacency. Done here, once every road lane exists and before any
   * connector does, because connectors are never siblings of anything: a lane
   * change happens on a link, never inside a junction box, where two crossing
   * movements off one arm are a conflict the phase builder cannot separate.
   *
   * A lane's *direction* is the (road, fromNode, toNode) triple, not the road
   * alone. On a two-way road the opposing direction carries the same `roadId`
   * and the same `index` values while running the other way, so keying on the
   * road would happily pair a lane with one coming at it head-on.
   */
  const byDirection = new Map<string, Lane[]>();
  for (const lane of lanes) {
    if (lane.kind !== "road") continue;
    const key = `${lane.roadId}:${lane.fromNode}:${lane.toNode}`;
    const group = byDirection.get(key);
    if (group === undefined) byDirection.set(key, [lane]);
    else group.push(lane);
  }
  for (const group of byDirection.values()) {
    const byIndex = new Map(group.map((l) => [l.index, l.id]));
    for (const lane of group) {
      lane.left = byIndex.get(lane.index - 1) ?? null;
      lane.right = byIndex.get(lane.index + 1) ?? null;
    }
  }

  /*
   * Which roads meet each node, and which lanes belong to each road.
   *
   * Both are one pass here to replace a scan inside the arm loop below. That
   * loop runs once per arm on the map — about four per junction — and used to
   * walk every road to find its own, then walk every lane on the map twice to
   * collect the lane ids at each end. On a city-sized grid that came to a few
   * hundred million comparisons and was the bulk of the time spent building the
   * network.
   */
  const roadsByNode = new Map<NodeId, RoadDef[]>();
  for (const road of level.roads) {
    for (const id of road.from === road.to ? [road.from] : [road.from, road.to]) {
      const list = roadsByNode.get(id);
      if (list) list.push(road);
      else roadsByNode.set(id, [road]);
    }
  }

  const lanesByRoad = new Map<string, Lane[]>();
  for (const lane of lanes) {
    if (lane.roadId === null) continue;
    const list = lanesByRoad.get(lane.roadId);
    if (list) list.push(lane);
    else lanesByRoad.set(lane.roadId, [lane]);
  }

  // --- Arms: group the lanes meeting each junction by road.
  const armsByJunction = new Map<NodeId, Arm[]>();
  for (const node of level.nodes) {
    if (node.kind !== "junction") continue;

    const arms: Arm[] = [];
    for (const road of roadsByNode.get(node.id) ?? []) {

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
        inbound: (lanesByRoad.get(road.id) ?? [])
          .filter((l) => l.toNode === node.id)
          .sort((p, q) => p.index - q.index)
          .map((l) => l.id),
        outbound: (lanesByRoad.get(road.id) ?? [])
          .filter((l) => l.fromNode === node.id)
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
        /*
         * Bus lanes are paired first and separately: a bus lane joins the
         * receiving arm's bus lane and nothing else.
         *
         * Letting it fall through to the general rules would send a bus from
         * the outermost lane into whatever lane the receiving road happened to
         * have, cutting diagonally across every general lane beside it. That is
         * a weave, the conflict builder correctly reports it as one, and the
         * junction pays an extra phase and its clearance interval for a
         * movement that in life is simply the bus lane continuing. Where the
         * corridor genuinely ends, emitting no connector is the honest answer —
         * the bus route does not turn there.
         */
        const busIn = fromArm.inbound.filter((id) => lanes[id].access === "bus");
        const busOut = toArm.outbound.filter((id) => lanes[id].access === "bus");
        const generalIn = fromArm.inbound.filter((id) => lanes[id].access === "all");
        const generalOut = toArm.outbound.filter((id) => lanes[id].access === "all");

        const lastIdx = generalIn.length - 1;

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
        const pairs: [LaneId, LaneId][] = [];

        // Straight on down the bus corridor. A bus lane never turns.
        if (turn === "straight" && busIn.length > 0 && busOut.length > 0) {
          pairs.push([busIn[0], busOut[0]]);
        }

        const general: [number, number][] =
          turn === "left"
            ? [[0, 0]]
            : turn === "right"
              ? [[lastIdx, generalOut.length - 1]]
              : generalIn.map(
                  (_, k) => [k, Math.min(k, generalOut.length - 1)] as [number, number],
                );

        for (const [fromK, toK] of general) {
          const src = generalIn[fromK];
          const dst = generalOut[toK];
          if (src !== undefined && dst !== undefined) pairs.push([src, dst]);
        }

        for (const [srcId, dstId] of pairs) {
          const fromK = lanes[srcId].index;
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
            // A connector inherits its feeding lane's restriction: the movement
            // out of a bus lane is as closed to general traffic as the lane is.
            access: src.access,
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
