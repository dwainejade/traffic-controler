/**
 * Level topology. The renderer and the simulation both build from this — road
 * meshes and lane splines come from the same source, so a stop line drawn on
 * screen sits exactly where the sim thinks the stop line is.
 */

/** Metres. One lane. */
export const LANE_WIDTH = 3.5

/**
 * Kerbside parking strip. Narrower than a lane because it holds a stationary
 * car and not a moving one.
 */
export const PARKING_WIDTH = 2.5

/**
 * Stop-line layout, measured outward from the edge of the junction box.
 * Shared by the renderer and the simulation so a painted stop bar always sits
 * exactly where the sim thinks cars must stop.
 */
export const CROSSWALK_GAP = 1.0
export const CROSSWALK_DEPTH = 4.0
export const STOP_BAR_GAP = 0.8
export const STOP_OFFSET = CROSSWALK_GAP + CROSSWALK_DEPTH + STOP_BAR_GAP

export type NodeId = string

/**
 * The OSM road hierarchy, carried through from the import so the simulation can
 * ask what kind of street a road is.
 *
 * Until now the `highway` tag was consumed inside the importer and thrown away —
 * it survived only folded into source spawn weights. Trucks need it back: a New
 * York truck route is defined by exactly this classification, and "stay on the
 * big streets" is not derivable from lane count or width.
 */
export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'unclassified'
  | 'residential'
  | 'living_street'

/**
 * Classes a through truck may use.
 *
 * This is the NYC through-truck-route rule in miniature: freight belongs on the
 * arterials and off the residential grid. On the Rogers map it resolves to
 * Rogers Avenue, Nostrand Avenue and Bedford Avenue, and nothing else.
 */
export const TRUCK_ROUTE: ReadonlySet<RoadClass> = new Set<RoadClass>([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
])

export type MapNode = {
  id: NodeId
  /** World position on the ground plane, [x, z]. */
  pos: [number, number]
  /**
   * `junction` — signal-controlled crossing the player operates.
   * `source`   — map edge where cars spawn and despawn.
   *
   * A source usually does both, but need not: where a one-way couplet crosses
   * the edge of an imported area, traffic arrives on one street and leaves on
   * another, so each of those sources works in one direction only. Which one it
   * is follows from the roads that touch it — nothing declares it.
   */
  kind: 'junction' | 'source'
  /**
   * Sources only: relative likelihood of a car entering here (default 1).
   * Uneven weights are what turn "heavy traffic" into a puzzle — an arterial
   * carrying several times its cross-streets creates a split decision that
   * uniform demand, measurably, does not.
   */
  spawnWeight?: number
  /** Sources only: relative likelihood of being chosen as a destination (default 1). */
  attractWeight?: number
}

export type RoadDef = {
  id: string
  from: NodeId
  to: NodeId
  /**
   * Moving lanes in each direction — the ones cars are simulated in. Bus lanes
   * and parking strips are *not* counted here; they are paved surface that
   * widens the street without adding capacity, which is exactly what they do in
   * life. Total driving width = lanesPerDir * 2 * LANE_WIDTH.
   */
  lanesPerDir: number
  /** Street name, for map labels. Presentational; the simulation never reads it. */
  name?: string
  /**
   * Where this street sits in the road hierarchy. Unlike `name`, the simulation
   * *does* read this: it is what confines trucks to the arterials. Absent on
   * hand-authored levels, which are treated as unrestricted.
   */
  class?: RoadClass
  /**
   * Kerbside parking strips: 0, 1 (the right-hand kerb) or 2. Widens the paved
   * surface and moves the kerb out, and nothing else — no car drives here.
   */
  parkingSides?: 0 | 1 | 2
  /**
   * Kerbside bus lanes, per direction. Painted, and closed to the cars the
   * simulation moves, so a road with two general lanes and a bus lane has the
   * capacity of two lanes and the width of three. Counting the bus lane as
   * general capacity would quietly overstate the street by a third.
   */
  busLanes?: { forward?: number; backward?: number }
  /**
   * Optional interior control points, [x, z] world coordinates. The centreline
   * becomes a Catmull-Rom spline through from → waypoints → to; absent, the
   * road is a two-point straight. Keep waypoints well clear of the junction
   * boxes at either end so the trimmed lane still leaves the box cleanly.
   */
  waypoints?: [number, number][]
  /**
   * Traffic flows from → to only. The carriageway narrows to one direction's
   * width and the lanes centre on the centreline. Never make a road touching a
   * `source` node one-way — every source must both feed and drain the map.
   */
  oneWay?: boolean
}

export type ZoneDef = {
  id: string
  /**
   * `park` is amenity green — mown, planted, walked in — and reads as an accent
   * with trees in it. `grass` is the leftover kind: verges, cemeteries, the
   * strip beside a school. Same family, a tone apart, and only parks get trees.
   */
  kind: 'park' | 'grass' | 'block'
  /** Axis-aligned rect: centre [x, z] plus half-extents [hx, hz]. */
  centre: [number, number]
  half: [number, number]
  /**
   * Optional true outline, [x, z] loop without a repeated last point. When
   * present it wins over the rect for fills and scatter, and `centre`/`half`
   * degrade to the polygon's bounding box. This is how street-graph faces —
   * including curved ones — become city blocks.
   */
  polygon?: [number, number][]
}

/**
 * Anything drawn as vegetation.
 *
 * `kind` is only ever compared with `===` — there is no exhaustive switch on it
 * anywhere — so adding a member is invisible to the type checker. Route new
 * green-vs-not tests through here rather than growing another comparison.
 */
export function isGreenZone(zone: ZoneDef): boolean {
  return zone.kind === 'park' || zone.kind === 'grass'
}

/**
 * A real building, as surveyed rather than scattered.
 *
 * Levels that have these draw them instead of the procedural boxes; levels that
 * do not are unaffected. Presentational — the simulation never reads them.
 */
export type BuildingFootprint = {
  /** Outline as an [x, z] loop, no repeated last point. */
  polygon: [number, number][]
  /** Metres to the roof. */
  height: number
  /** Index into the palette's building tints. */
  tint: number
}

export type LevelDef = {
  id: string
  name: string
  /** Half-extent of the ground card. */
  half: number
  nodes: MapNode[]
  roads: RoadDef[]
  zones: ZoneDef[]
  /** Seed for procedural building/tree scatter, so levels look identical every load. */
  seed: number
  /**
   * Surveyed building outlines. When present the scatter stops inventing
   * buildings and these are drawn instead — the streets came from a real place
   * and invented blocks beside them look exactly as wrong as they are.
   */
  footprints?: BuildingFootprint[]
  /** Cars that must complete their route to clear the level. */
  quota: number
  /**
   * City levels are scored on congestion, not throughput: survive the run with
   * total delay under this many vehicle-hours. When set, it replaces the quota
   * entirely — "keep the city moving" rather than "push cars through", which is
   * what a real traffic authority actually optimises.
   */
  delayBudget?: number
  /** Seconds available once the level starts. */
  timeLimit: number
  /** Cars per second arriving across all approaches. */
  demand: number
  /**
   * Demand profile over elapsed time: a piecewise-linear multiplier on
   * `demand`. With `loop` the profile wraps modulo its last point's `t`, so an
   * endless level gets recurring rush hours. Absent, demand is flat.
   */
  rush?: { points: { t: number; mult: number }[]; loop?: boolean }
  /**
   * No objective, no clock, no fail state: the level opens straight into
   * watch-and-tune mode. Collisions are logged and towed rather than ending
   * the run, exactly as in post-win observing.
   */
  sandbox?: boolean
  /**
   * Seconds of traffic to run before handing over, so a level opens with cars
   * already on it rather than filling up while you watch.
   *
   * This scales with the map, not with taste: a car needs long enough to cross
   * the whole network, and on a 49-junction city that is minutes, not seconds.
   * Warm a big map for as little as a single junction needs and it opens nearly
   * empty and takes ten minutes of watching to reach its steady state.
   */
  warmupSeconds?: number
  /**
   * Shoreline of the landmass the city stands on, as a closed [x, z] loop. When
   * present the ground is this shape surrounded by water instead of a
   * rectangular card, and map-edge sources sit out on the water as bridge
   * approaches. Purely presentational — the simulation never reads it.
   */
  island?: [number, number][]
  /**
   * The water around the island, as a closed loop enclosing it. Everything
   * outside this is the far bank, which is simply the backdrop — so the rivers
   * read as rivers and the bridges cross them to land somewhere.
   * Presentational only.
   */
  water?: [number, number][]
}

/** Default seconds of traffic to pre-run before a level is handed over. */
export const DEFAULT_WARMUP_SECONDS = 35

/** How long to warm a level: its own figure if it sets one, else the default. */
export function warmupFor(level: LevelDef): number {
  return level.warmupSeconds ?? DEFAULT_WARMUP_SECONDS
}

/** Width of the moving lanes alone. This is what the lane offsets are built on. */
export function roadWidth(road: RoadDef): number {
  return road.lanesPerDir * (road.oneWay ? 1 : 2) * LANE_WIDTH
}

/**
 * Where the kerbs sit, as signed lateral offsets from the centreline, positive
 * to the right of the from→to direction.
 *
 * The moving lanes never move: they stay exactly where `laneLateralOffset` puts
 * them, so adding parking or a bus lane cannot disturb a simulation that
 * already validates. Everything extra is stacked outboard of them, which makes
 * the paved surface asymmetric about the centreline whenever the two directions
 * are not equipped alike — a one-way street with a kerbside bus lane, most
 * obviously. That asymmetry is real and the renderer draws it.
 *
 * Order outward from the moving lanes: bus lane, then parking, then kerb.
 */
export function roadEdges(road: RoadDef): { left: number; right: number } {
  const bus = road.busLanes ?? {}
  const parking = road.parkingSides ?? 0
  const half = roadWidth(road) / 2

  // Two-way: the forward lanes fill the right half, the backward the left.
  // One-way: the lanes straddle the centreline, so both halves are the same.
  const drivingRight = road.oneWay ? half : roadWidth(road) / 2
  const drivingLeft = road.oneWay ? -half : -roadWidth(road) / 2

  let right = drivingRight + (bus.forward ?? 0) * LANE_WIDTH
  let left = drivingLeft - (road.oneWay ? 0 : (bus.backward ?? 0) * LANE_WIDTH)

  if (parking >= 1) right += PARKING_WIDTH
  if (parking >= 2) left -= PARKING_WIDTH

  return { left, right }
}

/** Kerb to kerb, including bus lanes and parking. */
export function pavedWidth(road: RoadDef): number {
  const { left, right } = roadEdges(road)
  return right - left
}

export function nodeById(level: LevelDef, id: NodeId): MapNode {
  const n = level.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`Unknown node "${id}" in level "${level.id}"`)
  return n
}

/**
 * Extra width the junction box carries beyond the widest road meeting it.
 *
 * A box sized exactly to the carriageway forces turning vehicles onto radii so
 * tight that opposing left-turn paths converge on the centre point and pass
 * through one another. Real junctions are wider than their approaches for the
 * same reason.
 */
export const JUNCTION_MARGIN = 5

/**
 * Floor on junction size, independent of road width.
 *
 * Two opposing left turns pass each other at a separation of
 * 2√2·(0.293·half − 0.707·laneOffset). For that to exceed a car's width the
 * half-width must be at least ~7.4m, whatever the roads are. A single-lane
 * crossroads is only 7m wide, so margin alone leaves its opposing lefts
 * overlapping — they then register as conflicting and the junction needs six
 * phases instead of four, quietly costing two extra clearance intervals a cycle.
 */
export const MIN_JUNCTION_SIZE = 16

/**
 * Widest road meeting at a node, plus margin — sets the size of the junction
 * box. Measured kerb to kerb: the box has to span the whole paved width or the
 * parking strips and bus lanes run visibly past its corners into the crossing.
 */
export function junctionSize(level: LevelDef, id: NodeId): number {
  const widths = level.roads
    .filter((r) => r.from === id || r.to === id)
    .map(pavedWidth)
  if (widths.length === 0) return 0
  return Math.max(Math.max(...widths) + JUNCTION_MARGIN, MIN_JUNCTION_SIZE)
}
