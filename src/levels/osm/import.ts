import type {
  BuildingFootprint,
  LevelDef,
  MapNode,
  NodeId,
  RoadClass,
  RoadDef,
  ZoneDef,
} from "../../sim/types";
import {
  JUNCTION_MARGIN,
  LANE_WIDTH,
  MIN_JUNCTION_SIZE,
  PARKING_WIDTH,
  STOP_OFFSET,
} from "../../sim/types";

/**
 * Turn a cached slice of OpenStreetMap into a level.
 *
 * The generated city (`cityGen.ts`) invents a plausible street pattern; this
 * does the opposite, and takes the pattern as given. That trade is the whole
 * point: a real half-kilometre of Brooklyn has a one-way avenue couplet with a
 * bus lane, cross-streets that alternate direction, and eighteen signals whose
 * spacing nobody chose — none of which a generator produces by accident, and
 * all of which are exactly what makes a junction interesting to re-time.
 *
 * The output is an ordinary `LevelDef`, so everything downstream — the sim, the
 * renderer, the validator — is unchanged and unaware.
 */

// --------------------------------------------------------------- OSM shapes

type OsmNode = { type: "node"; id: number; lat: number; lon: number; tags?: Tags };
type OsmWay = { type: "way"; id: number; nodes: number[]; tags?: Tags };
type Tags = Record<string, string>;

export type OsmFile = {
  elements: (OsmNode | OsmWay)[];
  bbox: { south: number; west: number; north: number; east: number };
};

/**
 * Ways cars may drive on. `service` is deliberately absent: it is driveways,
 * parking aisles and alley stubs, which add hundreds of dead ends and not one
 * decision worth making.
 */
const DRIVEABLE = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);

/**
 * Junction nodes closer together than this are one intersection that OSM
 * happens to model as several nodes — the two halves of a divided road, or a
 * slip lane split off a few metres early. This is the first, cheap pass; the
 * geometric one below catches whatever survives.
 */
const MERGE_RADIUS = 22;

/**
 * Street left between two junction boxes, beyond the boxes themselves. A stop
 * bar sits `STOP_OFFSET` out from each box and cars need somewhere to queue
 * behind it, so two boxes that merely fail to overlap are still too close.
 */
const BETWEEN_JUNCTIONS = STOP_OFFSET * 2 + 6;

/** Shortest stub from a junction out to a map-edge source. */
const MIN_STUB = STOP_OFFSET + 16;

/** Douglas-Peucker tolerance. Below this, a street is straight. */
const SIMPLIFY_TOLERANCE = 1.2;

// ------------------------------------------------------------------ helpers

type P = { x: number; z: number };

/**
 * Local metres about the box centre: x east, z south, so north is -z and the
 * map reads north-up on screen. At half a kilometre the difference between this
 * and a proper projection is under a centimetre, so there is nothing to gain
 * from a real one.
 */
function projector(bbox: OsmFile["bbox"]) {
  const lat0 = (bbox.south + bbox.north) / 2;
  const lon0 = (bbox.west + bbox.east) / 2;
  const mPerLat = 111132.92 - 559.82 * Math.cos((2 * lat0 * Math.PI) / 180);
  const mPerLon = 111412.84 * Math.cos((lat0 * Math.PI) / 180);
  return {
    project: (lat: number, lon: number): P => ({
      x: (lon - lon0) * mPerLon,
      z: -(lat - lat0) * mPerLat,
    }),
    halfX: ((bbox.east - bbox.west) / 2) * mPerLon,
    halfZ: ((bbox.north - bbox.south) / 2) * mPerLat,
  };
}

function dist(a: P, b: P): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Perpendicular distance from p to the line ab. */
function lineDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return dist(p, a);
  return Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / len;
}

/** Douglas-Peucker. Straight streets collapse to their two endpoints. */
function simplify(pts: P[], tol: number): P[] {
  if (pts.length <= 2) return pts;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = lineDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return [
    ...simplify(pts.slice(0, index + 1), tol).slice(0, -1),
    ...simplify(pts.slice(index), tol),
  ];
}

/** Where segment a->b leaves the axis-aligned box, as a fraction along it. */
function exitFraction(a: P, b: P, halfX: number, halfZ: number): number {
  let t = 1;
  const test = (num: number, den: number) => {
    if (Math.abs(den) < 1e-9) return;
    const s = num / den;
    if (s >= 0 && s < t) t = s;
  };
  test(halfX - a.x, b.x - a.x);
  test(-halfX - a.x, b.x - a.x);
  test(halfZ - a.z, b.z - a.z);
  test(-halfZ - a.z, b.z - a.z);
  return t;
}

/**
 * Position along the box's perimeter, walked clockwise (as seen from above,
 * +x east and +z south) starting at the top-left corner: 0 at (-halfX,
 * -halfZ), rising through each edge and corner, back to 4 at the start. Used
 * to close a clipped coastline against the box on the correct side without
 * hand-listing which corners to include for every entry/exit combination —
 * "walk clockwise from the exit's perimeter position to the entry's" is the
 * same one line of arithmetic regardless of which two edges they fall on.
 */
function perimeterPos(p: P, halfX: number, halfZ: number): number {
  const w = 2 * halfX;
  const h = 2 * halfZ;
  const x = p.x + halfX; // 0..w, left to right
  const z = p.z + halfZ; // 0..h, top to bottom
  if (Math.abs(z) < 1e-6) return x / w; // top edge, left -> right
  if (Math.abs(x - w) < 1e-6) return 1 + z / h; // right edge, top -> bottom
  if (Math.abs(z - h) < 1e-6) return 2 + (w - x) / w; // bottom edge, right -> left
  return 3 + (h - z) / h; // left edge, bottom -> top
}

/** The box corner at perimeter position `k` (0, 1, 2 or 3), clockwise from top-left. */
function cornerAt(k: number, halfX: number, halfZ: number): P {
  return [
    { x: -halfX, z: -halfZ },
    { x: halfX, z: -halfZ },
    { x: halfX, z: halfZ },
    { x: -halfX, z: halfZ },
  ][k];
}

/**
 * A directed coastline polyline (land on the left, water on the right — OSM's
 * own convention, and the reason `chain.forward` upstream must be honoured
 * rather than the chain taken in whatever order it was walked) turned into a
 * closed water polygon by clipping it to the box and closing the clipped ends
 * along the box perimeter.
 *
 * Only the single-crossing case is handled: the coastline enters the box once
 * and leaves it once, which is what an ordinary shoreline slicing through an
 * import box looks like. A box that straddles a headland or an island in the
 * harbour can cross more than once; skipped rather than guessed at, since a
 * wrong guess there draws land as sea or the reverse; a box entirely on one
 * side (no crossing at all) is likewise skipped — there is nothing in the
 * fetched data to say which side that is.
 */
function coastlinePolygon(pts: P[], halfX: number, halfZ: number): P[] | null {
  const inside = (p: P) => Math.abs(p.x) <= halfX && Math.abs(p.z) <= halfZ;

  // Every index where the polyline is inside the box on one side of it and
  // outside on the other, in path order — so, in the ordinary case of a
  // shoreline slicing straight through, exactly two: the crossing the path
  // goes in on and the one it comes back out on.
  const crossings: P[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (inside(a) === inside(b)) continue;
    const from = inside(a) ? a : b;
    const to = inside(a) ? b : a;
    const t = exitFraction(from, to, halfX, halfZ);
    crossings.push({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t });
  }

  // The clipped run of in-box points, opened with a true crossing where the
  // path enters from outside and closed with one where it leaves — or, if
  // the path's own end sits inside the box (the chain happens to end there
  // rather than exiting again), that endpoint instead.
  const startsInside = inside(pts[0]);
  const endsInside = inside(pts[pts.length - 1]);
  const expected = (startsInside ? 0 : 1) + (endsInside ? 0 : 1);
  if (crossings.length !== expected) return null; // a headland or an island: more than one
  // shore crossing the box, or (0 crossings, nothing inside) neither edge nor interior — both
  // out of scope, see above.
  if (!startsInside && !endsInside && crossings.length === 0) return null;

  const inner = pts.filter(inside);
  if (inner.length === 0 && crossings.length === 0) return null;

  const enter = startsInside ? pts[0] : crossings[0];
  const exit = endsInside ? pts[pts.length - 1] : crossings[crossings.length - 1];
  const poly: P[] = [enter, ...inner.filter((p) => p !== enter && p !== exit), exit];

  // Close along the box perimeter, clockwise from the exit back to the entry
  // — the side that keeps water (the box interior on the coastline's right)
  // inside the closed loop. `perimeterPos` increases clockwise from 0 to 4
  // and wraps, so "clockwise from the exit" is each of the four corners'
  // perimeter position measured onward from the exit's own (wrapped into
  // [0, 4)) — every corner whose onward distance is less than the entry's is
  // between them on the walk, and sorting by that distance puts them in the
  // walking order regardless of which edges the exit and entry sit on.
  const exitPos = perimeterPos(exit, halfX, halfZ);
  const enterPos = perimeterPos(enter, halfX, halfZ);
  const onwardFrom = (pos: number) => ((pos - exitPos) % 4 + 4) % 4;
  const enterOnward = onwardFrom(enterPos);

  const between = [0, 1, 2, 3]
    .map((corner) => ({ corner, onward: onwardFrom(corner) }))
    .filter(({ onward }) => onward > 1e-9 && onward < enterOnward)
    .sort((a, b) => a.onward - b.onward);

  for (const { corner } of between) poly.push(cornerAt(corner, halfX, halfZ));

  return poly;
}

/**
 * Sutherland-Hodgman: `poly` clipped to the axis-aligned box. A polygon
 * entirely inside is returned unchanged; entirely outside comes back empty.
 *
 * Needed for anything surveyed at real-world scale rather than city-block
 * scale — a waterfront park or a cemetery routinely runs for kilometres past
 * both edges of even the largest import box, and "keep it whole or drop it"
 * (the rule everything else here uses, buildings included) turns those into
 * nothing at all rather than the slice that legitimately falls inside.
 */
function clipPolyToBox(poly: P[], halfX: number, halfZ: number): P[] {
  type Edge = { inside: (p: P) => boolean; cross: (a: P, b: P) => P };
  const edges: Edge[] = [
    {
      inside: (p) => p.x <= halfX,
      cross: (a, b) => ({ x: halfX, z: a.z + ((halfX - a.x) / (b.x - a.x)) * (b.z - a.z) }),
    },
    {
      inside: (p) => p.x >= -halfX,
      cross: (a, b) => ({ x: -halfX, z: a.z + ((-halfX - a.x) / (b.x - a.x)) * (b.z - a.z) }),
    },
    {
      inside: (p) => p.z <= halfZ,
      cross: (a, b) => ({ z: halfZ, x: a.x + ((halfZ - a.z) / (b.z - a.z)) * (b.x - a.x) }),
    },
    {
      inside: (p) => p.z >= -halfZ,
      cross: (a, b) => ({ z: -halfZ, x: a.x + ((-halfZ - a.z) / (b.z - a.z)) * (b.x - a.x) }),
    },
  ];

  let output = poly;
  for (const edge of edges) {
    const input = output;
    output = [];
    if (input.length === 0) break;
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i - 1 + input.length) % input.length];
      const curIn = edge.inside(cur);
      const prevIn = edge.inside(prev);
      if (curIn) {
        if (!prevIn) output.push(edge.cross(prev, cur));
        output.push(cur);
      } else if (prevIn) {
        output.push(edge.cross(prev, cur));
      }
    }
  }
  return output;
}

// ----------------------------------------------------------------- lane tags

function laneCount(tags: Tags, oneWay: boolean): { fwd: number; bwd: number } {
  const num = (key: string) => {
    const v = Number(tags[key]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };

  // Bus lanes are counted inside `lanes` when tagged, but a bus lane is still a
  // lane of carriageway to draw and to drive in, so it stays in the total.
  const explicitF = num("lanes:forward");
  const explicitB = num("lanes:backward");
  const total = num("lanes");

  if (explicitF || explicitB) {
    return { fwd: explicitF || 1, bwd: oneWay ? 0 : explicitB || 1 };
  }
  if (total) {
    return oneWay
      ? { fwd: total, bwd: 0 }
      : { fwd: Math.ceil(total / 2), bwd: Math.floor(total / 2) || 1 };
  }

  // Untagged. NYC residential streets are one moving lane each way between
  // parked cars; an untagged one-way is one lane.
  const cls = tags.highway;
  const wide = cls === "secondary" || cls === "primary" || cls === "trunk";
  return oneWay
    ? { fwd: wide ? 2 : 1, bwd: 0 }
    : { fwd: wide ? 2 : 1, bwd: wide ? 2 : 1 };
}

/**
 * The way's place in the road hierarchy, as a `RoadClass`.
 *
 * Slip roads inherit their parent: a `secondary_link` is a stub of a secondary
 * and carries the same traffic, so a truck allowed on the avenue must be allowed
 * on the ramp that joins it — otherwise the route table has a hole exactly where
 * the arterial network connects to itself.
 */
function roadClass(tags: Tags): RoadClass | null {
  const cls = (tags.highway ?? "").replace(/_link$/, "");
  return ROAD_CLASSES.has(cls as RoadClass) ? (cls as RoadClass) : null;
}

const ROAD_CLASSES: ReadonlySet<RoadClass> = new Set<RoadClass>([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
]);

function isOneWay(tags: Tags): boolean {
  return tags.oneway === "yes" || tags.oneway === "1" || tags.oneway === "-1";
}

/** Bus lanes tagged on the way, per direction. */
function busLanes(tags: Tags): { fwd: number; bwd: number } {
  const num = (key: string) => {
    const v = Number(tags[key]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };
  return {
    fwd: num("lanes:bus:forward") || num("lanes:bus"),
    bwd: num("lanes:bus:backward"),
  };
}

/**
 * Moving lanes each direction gets.
 *
 * `lanes` in OSM counts the bus lane, and here it must not: a bus lane is
 * width, not capacity. Rogers Avenue is tagged `lanes=2` with
 * `lanes:bus:forward=1`, which is two general lanes and a bus lane beside them,
 * and treating it as three would overstate the avenue by half.
 */
function lanesPerDirection(tags: Tags, oneWay: boolean): number {
  const lanes = laneCount(tags, oneWay);
  const bus = busLanes(tags);
  const perDir = oneWay
    ? lanes.fwd - bus.fwd
    : Math.max(lanes.fwd - bus.fwd, lanes.bwd - bus.bwd);
  return Math.max(1, perDir);
}

/**
 * Whether a street has kerbside parking, and on how many sides.
 *
 * OSM's parking tags are sparse almost everywhere, so this leans on what is
 * true of the street type instead: in a residential American grid, kerbside
 * parking is the default state of the kerb, and its absence is what gets
 * signed. Trunk roads and slip lanes are the exception.
 */
function parkingSides(tags: Tags, oneWay: boolean): 0 | 1 | 2 {
  const explicit = (key: string) => tags[key];
  const noneOn = (v: string | undefined) => v === "no" || v === "none";

  const cls = tags.highway;
  if (cls === "motorway" || cls === "trunk" || cls.endsWith("_link")) return 0;

  const both = explicit("parking:both") ?? explicit("parking:lane:both");
  if (noneOn(both)) return 0;

  const left = explicit("parking:left") ?? explicit("parking:lane:left");
  const right = explicit("parking:right") ?? explicit("parking:lane:right");
  const sides = (noneOn(left) ? 0 : 1) + (noneOn(right) ? 0 : 1);

  // A one-way street still has two kerbs, and in this part of Brooklyn both of
  // them are parked solid.
  return (oneWay ? sides : sides) as 0 | 1 | 2;
}

/** Kerb to kerb, matching `pavedWidth` on the road this becomes. */
function carriagewayWidth(tags: Tags, oneWay: boolean): number {
  const bus = busLanes(tags);
  const driving = lanesPerDirection(tags, oneWay) * (oneWay ? 1 : 2) * LANE_WIDTH;
  const busWidth = (bus.fwd + (oneWay ? 0 : bus.bwd)) * LANE_WIDTH;
  return driving + busWidth + parkingSides(tags, oneWay) * PARKING_WIDTH;
}

function chainLength(pts: P[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/** Twice the signed area of a polygon. Sign gives the winding. */
function signedArea2(poly: P[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum;
}

/**
 * How tall a building is.
 *
 * `height` when it is tagged, `building:levels` when that is, and otherwise a
 * guess from the storey heights typical of the neighbourhood — deterministic in
 * the way's id, so a building is the same height on every load.
 */
function buildingHeight(tags: Tags, id: number): number {
  const explicit = parseFloat(tags.height ?? tags["building:height"] ?? "");
  if (Number.isFinite(explicit) && explicit > 1) return Math.min(explicit, 180);

  const levels = parseFloat(tags["building:levels"] ?? "");
  if (Number.isFinite(levels) && levels >= 1) return levels * STOREY + 1.2;

  // Untagged, which is most of them. A Brooklyn street is rowhouses with the
  // occasional apartment block, so this leans low and varies a little rather
  // than making every untagged building the same box.
  const kind = tags.building;
  if (kind === "garage" || kind === "shed" || kind === "roof") return 3;
  if (kind === "church" || kind === "school") return 12;

  const r = (Math.sin(id * 12.9898) * 43758.5453) % 1;
  const jitter = Math.abs(r);
  return 3 * STOREY + jitter * 3 * STOREY;
}

/** Floor-to-floor, metres. */
const STOREY = 3.2;

/**
 * Which green tone a way gets, or null if it is not green at all.
 *
 * The split is the one the palette cares about: `leisure` green is somewhere
 * you would go — a park, a garden, a ball field — and gets the accent colour
 * and trees. `landuse` green is the rest of it, and is terrain.
 */
function greenKind(tags: Tags): "park" | "grass" | null {
  if (tags.building || tags.natural === "water") return null;
  if (/^(park|garden|pitch)$/.test(tags.leisure ?? "")) return "park";
  if (/^(grass|cemetery|recreation_ground)$/.test(tags.landuse ?? "")) return "grass";
  return null;
}

/** A green patch smaller than this is a planter, not a place. */
const MIN_GREEN_AREA = 40;

/**
 * Even-odd point-in-polygon, over an `{x, z}` loop.
 *
 * `scatter.ts` has the same function for the same reason, and this is a
 * deliberate copy rather than an import: levels are built from OSM in Node as
 * well as in the browser, and the level layer does not depend on the renderer.
 */
function pointInPoly(x: number, z: number, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.z > z !== b.z > z &&
      x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// -------------------------------------------------------------------- import

type Edge = {
  a: number;
  b: number;
  /** True when a->b runs the same way as the OSM way's node order. */
  forward: boolean;
  tags: Tags;
};

export type ImportOptions = {
  id: string;
  name: string;
  /** Cars per second across the whole map. */
  demand?: number;
  seed?: number;
};

export function importOsm(file: OsmFile, opts: ImportOptions): LevelDef {
  const { project, halfX, halfZ } = projector(file.bbox);

  const rawNodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const el of file.elements) {
    if (el.type === "node") rawNodes.set(el.id, el);
    else if (el.type === "way") ways.push(el);
  }

  // --- 1. Positions, and the driveable edge list.
  const pos = new Map<number, P>();
  const at = (id: number): P => {
    const hit = pos.get(id);
    if (hit) return hit;
    const n = rawNodes.get(id);
    if (!n) throw new Error(`osm node ${id} referenced but not in the file`);
    const p = project(n.lat, n.lon);
    pos.set(id, p);
    return p;
  };

  let edges: Edge[] = [];
  for (const way of ways) {
    const tags = way.tags;
    if (!tags || !DRIVEABLE.has(tags.highway)) continue;
    if (tags.access === "private" || tags.access === "no") continue;
    for (let i = 0; i < way.nodes.length - 1; i++) {
      const a = way.nodes[i];
      const b = way.nodes[i + 1];
      if (!rawNodes.has(a) || !rawNodes.has(b)) continue;
      edges.push({ a, b, forward: true, tags });
    }
  }

  // --- 2. Clip to the box. An edge leaving it is cut at the boundary and the
  // outside end replaced by a synthetic node, which becomes a map-edge source.
  const inside = (p: P) => Math.abs(p.x) <= halfX && Math.abs(p.z) <= halfZ;
  let synthetic = -1;
  const clipped: Edge[] = [];

  for (const e of edges) {
    const pa = at(e.a);
    const pb = at(e.b);
    const ia = inside(pa);
    const ib = inside(pb);
    if (!ia && !ib) continue;
    if (ia && ib) {
      clipped.push(e);
      continue;
    }
    // One end is out. Cut there and keep the inside half.
    const [from, to] = ia ? [pa, pb] : [pb, pa];
    const t = exitFraction(from, to, halfX, halfZ);
    const cut = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
    const id = synthetic--;
    pos.set(id, cut);
    clipped.push(ia ? { ...e, b: id } : { ...e, a: id });
  }
  edges = clipped;

  // --- 3. Merge junction clusters. Big intersections are several OSM nodes.
  const degree = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    let s = degree.get(a);
    if (!s) degree.set(a, (s = new Set()));
    s.add(b);
  };
  for (const e of edges) {
    link(e.a, e.b);
    link(e.b, e.a);
  }

  const merged = new Map<number, number>(); // node -> representative
  const rep = (id: number): number => {
    const r = merged.get(id);
    return r === undefined || r === id ? id : rep(r);
  };
  const busy = [...degree.entries()]
    .filter(([, nbrs]) => nbrs.size >= 3)
    .map(([id]) => id);

  for (let i = 0; i < busy.length; i++) {
    for (let j = i + 1; j < busy.length; j++) {
      const a = rep(busy[i]);
      const b = rep(busy[j]);
      if (a === b) continue;
      if (dist(at(a), at(b)) < MERGE_RADIUS) merged.set(b, a);
    }
  }
  // Move each surviving representative to the centroid of what merged into it.
  const cluster = new Map<number, P[]>();
  for (const id of busy) {
    const r = rep(id);
    const list = cluster.get(r) ?? [];
    list.push(at(id));
    cluster.set(r, list);
  }
  for (const [r, pts] of cluster) {
    if (pts.length < 2) continue;
    pos.set(r, {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
    });
  }

  edges = edges
    .map((e) => ({ ...e, a: rep(e.a), b: rep(e.b) }))
    .filter((e) => e.a !== e.b);

  // --- 4. Prune dead ends. A degree-1 node that is not on the boundary is a
  // cul-de-sac, and the driving model carries no U-turn, so a car that enters
  // one is stuck for good. Pruning cascades: removing a stub can strand its
  // neighbour.
  const boundary = new Set<number>();
  for (const e of edges) {
    for (const id of [e.a, e.b]) if (id < 0) boundary.add(id);
  }

  for (;;) {
    const nbrs = new Map<number, Set<number>>();
    for (const e of edges) {
      for (const [a, b] of [
        [e.a, e.b],
        [e.b, e.a],
      ]) {
        let s = nbrs.get(a);
        if (!s) nbrs.set(a, (s = new Set()));
        s.add(b);
      }
    }
    const doomed = new Set(
      [...nbrs.entries()]
        .filter(([id, s]) => s.size <= 1 && !boundary.has(id))
        .map(([id]) => id),
    );
    if (doomed.size === 0) break;
    edges = edges.filter((e) => !doomed.has(e.a) && !doomed.has(e.b));
  }

  // --- 5. Chains. Degree-2 nodes are not intersections, they are where OSM
  // split a way to change a tag or follow a bend; they become waypoints.
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

  type Chain = { ids: number[]; tags: Tags; forward: boolean };

  const buildChains = (list: Edge[]): Chain[] => {
    const nbrs = new Map<number, Set<number>>();
    for (const e of list) {
      for (const [a, b] of [
        [e.a, e.b],
        [e.b, e.a],
      ]) {
        let s = nbrs.get(a);
        if (!s) nbrs.set(a, (s = new Set()));
        s.add(b);
      }
    }
    const isNode = (id: number) => (nbrs.get(id)?.size ?? 0) !== 2;

    const edgeBy = new Map<string, Edge>();
    for (const e of list) edgeBy.set(edgeKey(e.a, e.b), e);

    const out: Chain[] = [];
    const walked = new Set<string>();

    for (const start of [...nbrs.keys()].filter(isNode)) {
      for (const first of nbrs.get(start) ?? []) {
        if (walked.has(edgeKey(start, first))) continue;
        const ids = [start, first];
        walked.add(edgeKey(start, first));
        let prev = start;
        let cur = first;
        while (!isNode(cur)) {
          const next = [...(nbrs.get(cur) ?? [])].find((n) => n !== prev);
          if (next === undefined || walked.has(edgeKey(cur, next))) break;
          walked.add(edgeKey(cur, next));
          ids.push(next);
          prev = cur;
          cur = next;
        }
        const e = edgeBy.get(edgeKey(ids[0], ids[1]))!;
        // The chain was walked from `start`; the way may run the other way.
        out.push({ ids, tags: e.tags, forward: e.a === ids[0] });
      }
    }
    return out;
  };

  /*
   * Junctions that do not fit between each other are merged, and this is done
   * against the box each one will actually get rather than a fixed radius: a
   * junction box is sized by the widest road meeting it, so an avenue crossing
   * needs far more room than two residential corners. A road shorter than the
   * two half-boxes it runs between trims to nothing, and `trimPoly` throws.
   *
   * Merging changes the widths at the surviving junction, which can pull in a
   * neighbour that was previously clear, so this runs to a fixed point.
   */
  let chains = buildChains(edges);

  for (let pass = 0; pass < 8; pass++) {
    const widest = new Map<number, number>();
    for (const chain of chains) {
      const oneWay = isOneWay(chain.tags);
      const w = carriagewayWidth(chain.tags, oneWay);
      for (const end of [chain.ids[0], chain.ids[chain.ids.length - 1]]) {
        widest.set(end, Math.max(widest.get(end) ?? 0, w));
      }
    }
    const halfBox = (id: number) =>
      boundary.has(id) ? 0 : Math.max((widest.get(id) ?? 0) + JUNCTION_MARGIN, MIN_JUNCTION_SIZE) / 2;

    let didMerge = false;
    for (const chain of chains) {
      const a = rep(chain.ids[0]);
      const b = rep(chain.ids[chain.ids.length - 1]);
      if (a === b || boundary.has(a) || boundary.has(b)) continue;
      const len = chainLength(chain.ids.map(at));
      if (len >= halfBox(a) + halfBox(b) + BETWEEN_JUNCTIONS) continue;

      merged.set(b, a);
      pos.set(a, { x: (at(a).x + at(b).x) / 2, z: (at(a).z + at(b).z) / 2 });
      didMerge = true;
    }
    if (!didMerge) break;

    edges = edges
      .map((e) => ({ ...e, a: rep(e.a), b: rep(e.b) }))
      .filter((e) => e.a !== e.b);
    chains = buildChains(edges);
  }

  /*
   * Chains that begin and end at the same junction.
   *
   * Merging collapses two nearby junctions into one, and where a short link ran
   * between them — a slip road round a plaza, the tip of a one-way couplet, the
   * kerbed island at Boerum Place — both of its ends become the *same* node and
   * the link becomes a loop.
   *
   * The edge filter above cannot catch these: its self-loop test runs on
   * individual edges, and the loop only closes later, once `buildChains`
   * collapses the degree-2 nodes in between. So the pair test in the merge pass
   * skips them (a === b) and they survive all the way to the level.
   *
   * There is nothing to keep. The lane model has no way to express a movement
   * from a junction back into itself — `classifyTurn` reads it as a U-turn and
   * declines it — and the loop is by construction shorter than the box at both
   * of its ends, so trimming it back to the carriageway leaves no road at all
   * and `trimPoly` throws. Downtown Brooklyn produces six of them; the Rogers
   * extract, being an ordinary grid, produced none, which is why this went
   * unnoticed until now.
   */
  chains = chains.filter(
    (c) => rep(c.ids[0]) !== rep(c.ids[c.ids.length - 1]),
  );

  // Shared by every "kept whole or not at all by centroid" pass below —
  // buildings, green space, water — so a feature a few metres past the card's
  // own edge (which is itself grown past the box for the sources) still lands
  // on the map instead of being clipped off.
  const margin = 30;

  // --- 6. Water, ahead of road assembly so bridges can be detected as roads
  // are built.
  const waterBodies: [number, number][][] = [];

  // 6a. Closed rings — ponds, rivers, wastewater basins. Kept whole or not at
  // all by centroid, same shape as the green-space pass below, but with
  // nothing to contain: unlike a park with a lawn inside it, OSM does not
  // nest water features.
  for (const way of ways) {
    if (way.tags?.natural !== "water") continue;
    const ring = way.nodes.slice(0, -1);
    if (ring.length < 3) continue;
    if (way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    if (!ring.every((id) => rawNodes.has(id))) continue;

    const poly = ring.map(at);
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    const cz = poly.reduce((s, p) => s + p.z, 0) / poly.length;
    if (Math.abs(cx) > halfX + margin || Math.abs(cz) > halfZ + margin) continue;

    const area = Math.abs(signedArea2(poly)) / 2;
    if (area < MIN_GREEN_AREA) continue;

    waterBodies.push(poly.map((p) => [p.x, p.z] as [number, number]));
  }

  // 6b. Coastline — the sea, a bay, a harbour. OSM does not map open water as
  // a filled polygon at all; a `natural=coastline` way is the shoreline
  // itself, an open curve with land on its left and water on its right (the
  // standing convention every renderer of OSM coastline data relies on,
  // since nothing else says which side is which). Turned into a water
  // polygon by closing it along the box edge, on the water side.
  {
    const coastWays = ways.filter((w) => w.tags?.natural === "coastline");
    if (coastWays.length > 0) {
      const coastEdges: Edge[] = [];
      for (const way of coastWays) {
        for (let i = 0; i < way.nodes.length - 1; i++) {
          const a = way.nodes[i];
          const b = way.nodes[i + 1];
          if (!rawNodes.has(a) || !rawNodes.has(b)) continue;
          coastEdges.push({ a, b, forward: true, tags: way.tags! });
        }
      }
      const coastChains = buildChains(coastEdges);
      for (const chain of coastChains) {
        // `chain.forward` is true when `chain.ids` already runs the way the
        // first edge's own `a -> b` did — which, because every `coastEdges`
        // entry above was built in the way's original node order, is OSM's
        // own direction: land on the left, water on the right. `forward:
        // false` means the walk ran the chain backwards, so reverse it back.
        const ids = chain.forward ? chain.ids : [...chain.ids].reverse();
        const poly = coastlinePolygon(ids.map(at), halfX, halfZ);
        if (poly) waterBodies.push(poly.map((p) => [p.x, p.z] as [number, number]));
      }
    }
  }

  /**
   * `t` along segment ab where it crosses segment cd, or null if it doesn't.
   * Used to find where a road's centreline enters or leaves a water polygon.
   */
  function segCrossesSeg(a: P, b: P, c: P, d: P): number | null {
    const r = { x: b.x - a.x, z: b.z - a.z };
    const s = { x: d.x - c.x, z: d.z - c.z };
    const denom = r.x * s.z - r.z * s.x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((c.x - a.x) * s.z - (c.z - a.z) * s.x) / denom;
    const u = ((c.x - a.x) * r.z - (c.z - a.z) * r.x) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return t;
  }

  /** Arc-length span of `pts` that lies inside `poly`, or null if it never does. */
  function spanInsidePoly(pts: P[], poly: P[]): { from: number; to: number } | null {
    const cum = new Array<number>(pts.length);
    cum[0] = 0;
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + dist(pts[i - 1], pts[i]);

    let from = Infinity;
    let to = -Infinity;
    if (pointInPoly(pts[0].x, pts[0].z, poly)) from = Math.min(from, 0);
    if (pointInPoly(pts[pts.length - 1].x, pts[pts.length - 1].z, poly)) {
      to = Math.max(to, cum[cum.length - 1]);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = 0; j < poly.length; j++) {
        const t = segCrossesSeg(pts[i], pts[i + 1], poly[j], poly[(j + 1) % poly.length]);
        if (t === null) continue;
        const s = cum[i] + t * (cum[i + 1] - cum[i]);
        from = Math.min(from, s);
        to = Math.max(to, s);
      }
    }
    return from <= to ? { from, to } : null;
  }

  /**
   * A road's deck span, or undefined if it carries none.
   *
   * `bridge=yes`/`bridge=viaduct` is ground truth when OSM tags it; lacking
   * that, a centreline that geometrically crosses a water body is a bridge
   * regardless. Either way the water crossing (if any) sets the span exactly
   * — the tag alone says only that a bridge exists somewhere on the way, not
   * where, and a way can extend well past the water on both banks.
   */
  function findDeck(tags: Tags, line: P[]): RoadDef["deck"] {
    const tagged = tags.bridge === "yes" || tags.bridge === "viaduct" || Number(tags.layer) > 0;

    for (const poly of waterBodies) {
      const span = spanInsidePoly(line, poly.map(([x, z]) => ({ x, z })));
      if (span) return { ...span, kind: "bridge" };
    }
    if (!tagged) return undefined;

    // Tagged as elevated but not over water: an overpass across another
    // road. No water polygon to size the span against, so raise the whole
    // way — better an overlong deck than a bridge tag silently dropped.
    const cum = new Array<number>(line.length);
    cum[0] = 0;
    for (let i = 1; i < line.length; i++) cum[i] = cum[i - 1] + dist(line[i - 1], line[i]);
    return { from: 0, to: cum[cum.length - 1], kind: "overpass" };
  }

  // --- 7. Assemble the level.
  const nodes: MapNode[] = [];
  const roads: RoadDef[] = [];
  const idOf = new Map<number, NodeId>();
  const nameOf = (osmId: number): NodeId => {
    let n = idOf.get(osmId);
    if (!n) {
      n = osmId < 0 ? `src${-osmId}` : `j${osmId}`;
      idOf.set(osmId, n);
    }
    return n;
  };

  const used = new Set<number>();
  for (const chain of chains) {
    used.add(chain.ids[0]);
    used.add(chain.ids[chain.ids.length - 1]);
  }

  /*
   * A source sits where its street crossed the edge of the box, and a junction
   * can easily sit a couple of metres inside that — which leaves a stub shorter
   * than the junction's own box. Rather than merge (there is nothing to merge
   * with) the source is pushed further out along the street until the stub is
   * long enough to hold a stop bar and a short queue. The card is grown to suit,
   * so these still land on the map rather than off the edge of the world.
   */
  let outermost = 0;
  for (const chain of chains) {
    const [head, tail] = [chain.ids[0], chain.ids[chain.ids.length - 1]];
    const source = boundary.has(head) ? head : boundary.has(tail) ? tail : null;
    if (source === null) continue;
    const junction = source === head ? tail : head;
    if (boundary.has(junction)) continue;

    const w = carriagewayWidth(chain.tags, isOneWay(chain.tags));
    const half = Math.max(w + JUNCTION_MARGIN, MIN_JUNCTION_SIZE) / 2;
    const need = half + MIN_STUB;

    const from = at(junction);
    const to = at(source);
    const have = dist(from, to);
    if (have >= need) {
      outermost = Math.max(outermost, Math.abs(to.x), Math.abs(to.z));
      continue;
    }
    // Straight out along the last leg of the street, so the stub stays aligned
    // with the road it extends rather than kinking at the boundary.
    const prev = at(chain.ids[source === head ? 1 : chain.ids.length - 2]);
    const dx = to.x - prev.x;
    const dz = to.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    const moved = { x: from.x + (dx / len) * need, z: from.z + (dz / len) * need };
    pos.set(source, moved);
    outermost = Math.max(outermost, Math.abs(moved.x), Math.abs(moved.z));
  }

  /*
   * How much traffic a source carries follows the street it sits on. Uniform
   * demand would put as many cars onto Fenimore Street as onto Rogers Avenue,
   * which is both wrong and dull: the interesting problem is an arterial
   * meeting cross-streets that carry a fraction of its flow, and that contrast
   * has to come from somewhere.
   */
  const CLASS_WEIGHT: Record<string, number> = {
    motorway: 8,
    trunk: 6,
    primary: 5,
    secondary: 4,
    tertiary: 2.5,
    unclassified: 1.2,
    residential: 1,
    living_street: 0.5,
  };
  /*
   * A one-way source carries less than its class suggests. It works in one
   * direction only, so where a two-way street's weight is split between arrivals
   * and departures, a one-way's is spent entirely on one of them — the same
   * number puts twice the traffic through the street. Beyond the arithmetic, a
   * one-way is half of a couplet and only ever carries half of what the pair
   * moves between them.
   */
  const ONE_WAY_SHARE = 0.45;

  const sourceWeight = new Map<number, number>();
  for (const chain of chains) {
    for (const end of [chain.ids[0], chain.ids[chain.ids.length - 1]]) {
      if (!boundary.has(end)) continue;
      const base = CLASS_WEIGHT[chain.tags.highway] ?? 1;
      const w = isOneWay(chain.tags) ? base * ONE_WAY_SHARE : base;
      sourceWeight.set(end, Math.max(sourceWeight.get(end) ?? 0, w));
    }
  }

  for (const osmId of used) {
    const p = at(osmId);
    const isSource = boundary.has(osmId);
    const weight = sourceWeight.get(osmId) ?? 1;
    nodes.push({
      id: nameOf(osmId),
      pos: [p.x, p.z],
      kind: isSource ? "source" : "junction",
      ...(isSource ? { spawnWeight: weight, attractWeight: weight } : {}),
    });
  }

  let n = 0;
  for (const chain of chains) {
    const tags = chain.tags;
    const oneWayTag = isOneWay(tags);
    // `oneway=-1` means the way runs against its own node order.
    const wayForward = tags.oneway === "-1" ? !chain.forward : chain.forward;

    let ids = chain.ids;
    // Orient the road so from->to is the direction traffic may travel.
    if (oneWayTag && !wayForward) ids = [...ids].reverse();

    const pts = ids.map(at);
    const line = simplify(pts, SIMPLIFY_TOLERANCE);
    const waypoints = line.slice(1, -1).map((p) => [p.x, p.z] as [number, number]);

    /*
     * `lanes:bus:forward` is relative to the OSM way's own node order, and the
     * road being built may run either way along it: the chain could have been
     * walked backwards, and one-ways are then re-oriented to point the way
     * traffic moves. Work out whether from→to ends up agreeing with the way,
     * and swap the two directions only when it does not.
     *
     * For `oneway=yes` the answer is always yes — traffic runs along the way by
     * definition — which is why an earlier version that swapped whenever the
     * chain had been reversed put Rogers Avenue's bus lane on the side of the
     * street with no traffic on it.
     */
    const reversedIds = oneWayTag && !wayForward;
    const roadRunsWithWay = reversedIds ? !chain.forward : chain.forward;

    const bus = busLanes(tags);
    const busForward = roadRunsWithWay ? bus.fwd : bus.bwd;
    // A one-way street has no backward side to put a bus lane on.
    const busBackward = oneWayTag ? 0 : roadRunsWithWay ? bus.bwd : bus.fwd;

    const deck = findDeck(tags, line);

    roads.push({
      id: `r${n++}`,
      from: nameOf(ids[0]),
      to: nameOf(ids[ids.length - 1]),
      lanesPerDir: lanesPerDirection(tags, oneWayTag),
      ...(tags.name ? { name: tags.name } : {}),
      ...(roadClass(tags) ? { class: roadClass(tags)! } : {}),
      ...(oneWayTag ? { oneWay: true } : {}),
      ...(busForward || busBackward
        ? { busLanes: { forward: busForward, backward: busBackward } }
        : {}),
      parkingSides: parkingSides(tags, oneWayTag),
      ...(waypoints.length ? { waypoints } : {}),
      ...(deck ? { deck } : {}),
    });
  }

  /*
   * --- 7. Buildings.
   *
   * Kept whole or not at all, by centroid: a building straddling the edge of
   * the box is either in or out, and clipping the polygon would leave sliced
   * boxes standing open along all four edges. A few metres of overhang past the
   * card is cheaper than that, and the card is grown for the sources anyway.
   */
  const footprints: BuildingFootprint[] = [];

  for (const way of ways) {
    if (!way.tags?.building) continue;
    // Closed loops only, and OSM repeats the first node at the end.
    const ring = way.nodes.slice(0, -1);
    if (ring.length < 3) continue;
    if (way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    if (!ring.every((id) => rawNodes.has(id))) continue;

    const poly = ring.map(at);
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    const cz = poly.reduce((s, p) => s + p.z, 0) / poly.length;
    if (Math.abs(cx) > halfX + margin || Math.abs(cz) > halfZ + margin) continue;

    const area = Math.abs(signedArea2(poly)) / 2;
    // Sub-shed slivers are mapping noise, not buildings.
    if (area < 12) continue;

    // Wound counter-clockwise, so the extruded walls face outward.
    const wound = signedArea2(poly) < 0 ? [...poly].reverse() : poly;

    footprints.push({
      polygon: wound.map((p) => [p.x, p.z] as [number, number]),
      height: buildingHeight(way.tags, way.id),
      tint: Math.abs(way.id) % 4,
    });
  }

  /*
   * --- 8. Green space.
   *
   * Closed rings only, same as the buildings above, but clipped to the box
   * rather than kept whole or dropped: a waterfront park or a cemetery
   * routinely runs for kilometres past both edges of even the largest import
   * box (Shore Road Park is one continuous way for most of the Brooklyn
   * shoreline), and rejecting anything whose centroid falls outside the box
   * — which is what a park like that does even though most of its width is
   * inside — was silently dropping real parkland rather than showing the
   * slice that is actually in view. A polygon that never touches the box at
   * all still costs nothing to skip; `clipPolyToBox` returns it empty.
   *
   * The one addition is the containment pass. OSM routinely maps a park as a
   * `leisure=park` boundary with `landuse=grass` lawns drawn inside it, and
   * sometimes a `leisure=garden` inside those — drawing all three stamps a
   * differently-coloured patch into the middle of the park. Largest first, and
   * anything whose centroid lands in one already kept is the same ground being
   * described twice.
   */
  type Green = { kind: "park" | "grass"; poly: P[]; area: number; id: number };
  const green: Green[] = [];

  for (const way of ways) {
    const kind = way.tags && greenKind(way.tags);
    if (!kind) continue;
    const ring = way.nodes.slice(0, -1);
    if (ring.length < 3) continue;
    if (way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    if (!ring.every((id) => rawNodes.has(id))) continue;

    let poly = ring.map(at);
    const xs = poly.map((p) => p.x);
    const zs = poly.map((p) => p.z);
    const outOfBox =
      Math.min(...xs) < -halfX ||
      Math.max(...xs) > halfX ||
      Math.min(...zs) < -halfZ ||
      Math.max(...zs) > halfZ;
    if (outOfBox) {
      poly = clipPolyToBox(poly, halfX + margin, halfZ + margin);
      if (poly.length < 3) continue; // never touched the box at all
    }

    const twice = signedArea2(poly);
    const area = Math.abs(twice) / 2;
    if (area < MIN_GREEN_AREA) continue;

    green.push({
      kind,
      poly: twice < 0 ? [...poly].reverse() : poly,
      area,
      id: way.id,
    });
  }

  green.sort((a, b) => b.area - a.area);

  const zones: ZoneDef[] = [];
  const keptGreen: Green[] = [];
  for (const g of green) {
    const cx = g.poly.reduce((s, p) => s + p.x, 0) / g.poly.length;
    const cz = g.poly.reduce((s, p) => s + p.z, 0) / g.poly.length;
    // Quadratic, but there are a couple of hundred of these at the very most.
    if (keptGreen.some((k) => pointInPoly(cx, cz, k.poly))) continue;
    keptGreen.push(g);

    const xs = g.poly.map((p) => p.x);
    const zs = g.poly.map((p) => p.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);

    zones.push({
      id: `green${g.id}`,
      kind: g.kind,
      centre: [(minX + maxX) / 2, (minZ + maxZ) / 2],
      half: [(maxX - minX) / 2, (maxZ - minZ) / 2],
      polygon: g.poly.map((p) => [p.x, p.z] as [number, number]),
    });
  }

  return {
    id: opts.id,
    name: opts.name,
    footprints,
    // The card covers the box and whatever the sources were pushed out to.
    half: Math.max(halfX, halfZ, outermost + 10),
    nodes,
    roads,
    zones,
    ...(waterBodies.length ? { waterBodies } : {}),
    seed: opts.seed ?? 20260810,
    quota: 0,
    timeLimit: 0,
    demand: opts.demand ?? 0.9,
    sandbox: true,
    warmupSeconds: 60,
  };
}
