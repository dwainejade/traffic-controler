/**
 * Transit mode: the bus network the player draws, and the people who use it.
 *
 * The traffic simulation underneath does not change. Buses are ordinary
 * vehicles in it — they queue at the same red lights, sit behind the same
 * turning car, and are subject to the same car-following model. What is added
 * here is everything the sim had no opinion about: which way a bus goes, where
 * it stops, and whether anybody got where they were going.
 *
 * Three things are deliberately *not* modelled in this first pass, and each is
 * a decision rather than an omission:
 *
 * - **No transfers.** A rider takes one bus or no bus. Journey planning across
 *   two lines is a shortest-path problem over a graph the player is editing
 *   live, and it would hide the thing the game is about: if a trip needs two
 *   lines, the player should feel the gap, not have it quietly papered over.
 * - **No walking network.** Riders walk in straight lines at a fixed pace, and
 *   only within `WALK_RADIUS`. Pathing them around blocks would cost more than
 *   it shows at this camera height.
 * - **No fares, no vehicle purchase.** Buses are placed, not bought. The
 *   economy is the obvious next layer and would sit entirely on top of this.
 */

import type { Lane, LaneId, Network } from './network'
import { samplePoly } from './centreline'
import type { NodeId } from './types'
import {
  chainIsContinuous,
  chainLength,
  lanesLeaving,
  pathBetween,
  pathToLane,
  pathToNode,
} from './transitGraph'
import { VEHICLE } from './vehicles'
import { mulberry32 } from '../render/geometry'

// ------------------------------------------------------------------ tuning

/**
 * How far somebody will walk to a bus, metres.
 *
 * The transit-planning rule of thumb is a quarter mile — about 400m — and that
 * is for a service worth walking to. At the block sizes this city uses that is
 * two long blocks, which is the right feel: a route down one avenue picks up the
 * street either side of it and nothing beyond, so parallel routes are worth
 * drawing and a single route across the map is not a solution.
 */
export const WALK_RADIUS = 400

/** Walking pace, m/s. A shade under 3 mph, which is what a city walk is. */
const WALK_SPEED = 1.3

/**
 * Seconds a rider will stand at a stop before giving up and going home.
 *
 * This is the whole failure mode of the game and the only pressure on the
 * player: a route can be drawn perfectly and still fail if it has one bus on it
 * and a fifteen-minute round trip. Ten minutes is generous for a city and
 * deliberately so — the player should lose riders to *bad frequency*, which is
 * a fixable mistake they can see, not to ordinary traffic.
 */
const PATIENCE = 600

/**
 * Seconds an unserved trip stands on the corner before giving up.
 *
 * Long enough to be seen at the speeds this game is watched at, short enough
 * that a city with no network at all does not silt up with a permanent crowd
 * that hides the moment a line starts working.
 */
const UNSERVED_LINGER = 45

/** People on a 40-foot bus, seated and standing. */
export const BUS_CAPACITY = 60

/** Seconds a bus holds with its doors open, plus a little per person moving. */
const DWELL_BASE = 4
const DWELL_PER_RIDER = 0.6
/** Even an empty stop costs the pull-in and pull-out. */
const DWELL_MIN = 5
const DWELL_MAX = 45

/**
 * Metres past a junction a stop sits, matching `buildBusStops`.
 *
 * Far side, for the reason set out there: a near-side stop parks a dwelling bus
 * across its own stop line and blocks every phase it is not being served by.
 */
const STOP_OFFSET_PAST_JUNCTION = 18

/**
 * Shortest gap between two stops on one route, metres.
 *
 * Matching `buildBusStops`, which put the ambient service's stops about a
 * long block apart. Closer than this and the bus spends the whole route with
 * its doors open; further and the walk to it eats the time the ride saved.
 */
const MIN_STOP_SPACING = 150

/**
 * Shortest block a stop will fit in: the offset past the junction, the bus
 * itself, and enough left over that it is not still in the next junction box.
 */
const MIN_STOP_BLOCK = STOP_OFFSET_PAST_JUNCTION + VEHICLE.bus.length + 8

/**
 * Transit stop ids live above this so they can share `Car.servedStop` with the
 * bus-lane stops the network builds for the ambient service without either
 * being able to be mistaken for the other.
 */
const TRANSIT_STOP_BASE = 1_000_000

// ------------------------------------------------------------------- model

export type StopId = number
export type RouteId = string
export type RiderId = number

/** A place a bus pulls up, and the people standing there. */
export type TransitStop = {
  id: StopId
  routeId: RouteId
  /** Which lane, and how far along it, the bus stands. */
  laneId: LaneId
  laneS: number
  /** Position in the route's lane chain, so "is this stop after that one" is an index test. */
  legIndex: number
  x: number
  z: number
  angle: number
  /** The junction this stop serves, for naming and for picking. */
  node: NodeId
  /** Rider ids standing here, in arrival order. */
  waiting: RiderId[]
  /** Set false by the player to skip a stop without redrawing the route. */
  enabled: boolean
}

export type TransitRoute = {
  id: RouteId
  name: string
  /** Index into `LINE_COLORS`. */
  colour: number
  /** The junctions the player clicked, in order. The route's authored shape. */
  nodes: NodeId[]
  /**
   * The closed lane chain buses actually drive: the drawn path, then a return
   * leg back to the first node.
   *
   * Closed rather than out-and-back-and-reverse because the model has no
   * U-turn: a bus that reached the end of the drawn path and tried to turn
   * round would need a movement the junction does not offer. Routing a return
   * leg instead also gets one-way streets right for free — the way back down a
   * one-way avenue is the next avenue over, which is exactly what a real route
   * does.
   */
  lanes: LaneId[]
  /** Where the drawn path ends and the return leg begins, as an index into `lanes`. */
  returnAt: number
  stops: TransitStop[]
  /**
   * Buses the player has asked for on this route.
   *
   * The target, not the count on the road. They differ for two reasons and both
   * matter: a bus can be towed after a collision, and a spawn can be refused
   * because the terminus is occupied. Keeping only the achieved count would let
   * a line silently shrink — one tow and it runs a bus short for the rest of
   * the game, with nothing but a slowly emptying stop to say so.
   */
  buses: number
  /** How many are actually out there right now. */
  running: number
  /** Metres round the loop. */
  length: number
}

/** Somewhere people are trying to get to. One colour on the map. */
export type Destination = {
  id: number
  x: number
  z: number
  /** Relative share of all trips ending here. */
  weight: number
  /** Set by the renderer: which drawn building wears this colour. */
  building: number
}

export type RiderPhase =
  /** On foot, between home and the stop they will board at. */
  | 'walking'
  /** Standing at a stop. */
  | 'waiting'
  /** On a bus. */
  | 'riding'
  /** On foot, between the stop they got off at and the destination. */
  | 'arriving'
  /** Appeared, found nothing within walking distance, and is about to give up. */
  | 'unserved'

export type Rider = {
  id: RiderId
  active: boolean
  phase: RiderPhase
  /** Index into `destinations`. */
  destination: number
  /** Where they started. */
  homeX: number
  homeZ: number
  /** Current drawn position. */
  x: number
  z: number
  /** Walk interpolation: from → to, and how far along. */
  fromX: number
  fromZ: number
  toX: number
  toZ: number
  walked: number
  walkLength: number
  /** The plan: board here, get off there. -1 when they never found one. */
  boardStop: StopId
  alightStop: StopId
  /** Seconds since spawning, for the score and for patience. */
  age: number
  /** Seconds spent standing at a stop. */
  waited: number
  /** The bus they are on, or -1. */
  bus: number
}

export type TransitStats = {
  spawned: number
  delivered: number
  /** Gave up at a stop, or never had a service to use. */
  missed: number
  /** Standing at a stop, waiting for a bus that is coming. */
  waiting: number
  riding: number
  walking: number
  /**
   * Standing on a corner with no line they can use, about to give up.
   *
   * Counted apart from `waiting` because they mean opposite things to the
   * player: waiting is the service working, unserved is the map telling them
   * where it does not reach. Folding the two together made a city with no
   * network at all look busy.
   */
  unserved: number
  /** Mean door-to-door seconds over delivered riders. */
  meanJourney: number
  /** Mean seconds spent standing at a stop, over delivered riders. */
  meanWait: number
}

/** What the world needs to be able to do for the transit layer to run. */
export type TransitHost = {
  net: Network
  /** Put a bus on `route` at arc length `at` along its first lane. */
  spawnBus(route: LaneId[], at: number, routeId: RouteId, colour: number): number | null
  /** Take a bus off the map. */
  despawnBus(carId: number): void
  /** World position of a car, for drawing riders on board and finding stops. */
  carPose(carId: number, out: { x: number; z: number; angle: number }): boolean
  /** Whether that car is still on the map. */
  carActive(carId: number): boolean
  /**
   * The set of lanes a route runs on has changed.
   *
   * The world clips the simulation to what the camera can see, and a bus route
   * is exempt from that — so the exemption has to be recomputed when a line is
   * added or deleted, which is not a moment the camera moves.
   */
  regionChanged(): void
}

// -------------------------------------------------------------------- helpers

/** Composite key for the lane-and-route stop index. */
function key(laneId: LaneId, routeId: RouteId): string {
  return `${laneId}:${routeId}`
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz)
}

/** A lane's points, as the pairs the samplers want. */
function laneToPoly(lane: Lane): { x: number; z: number }[] {
  const poly: { x: number; z: number }[] = []
  for (let i = 0; i < lane.pts.length; i += 2) poly.push({ x: lane.pts[i], z: lane.pts[i + 1] })
  return poly
}

/** Buses may drive general traffic lanes and bus lanes, and nothing else. */
export function busPassable(lane: Lane): boolean {
  return lane.access === 'all' || lane.access === 'bus'
}

// --------------------------------------------------------------------- build

/**
 * Turn a list of clicked junctions into a closed, drivable loop.
 *
 * Each click is resolved against the lane the previous leg *ended* on, not
 * against the junction in the abstract, so the turn out of every leg is a
 * movement the junction actually offers. Resolving each leg independently and
 * concatenating would produce chains that look right on the map and contain
 * joins no bus can make.
 *
 * Returns null when any leg is unreachable — a one-way pair with no way back is
 * the usual cause, and the right answer is to tell the player rather than to
 * invent a movement.
 */
export function buildRouteLanes(
  net: Network,
  nodes: NodeId[],
): { lanes: LaneId[]; returnAt: number } | null {
  if (nodes.length < 2) return null

  const first = pathBetween(net, nodes[0], nodes[1], busPassable)
  if (!first) return null

  const lanes = [...first.lanes]

  for (let i = 2; i < nodes.length; i++) {
    const head = lanes[lanes.length - 1]
    const leg = pathToNode(net, head, nodes[i], busPassable)
    if (!leg) return null
    // `leg` starts on the lane the previous one ended on, so drop that repeat.
    lanes.push(...leg.lanes.slice(1))
  }

  const returnAt = lanes.length

  /*
   * The way back.
   *
   * Direct first: on a two-way street the shortest path home is the street the
   * line came out on, and on a one-way grid it is the avenue alongside, which
   * is exactly what a real route does.
   *
   * Failing that, retrace — leg by leg back through the junctions the player
   * clicked, in reverse. The direct search can fail on an imported map for
   * reasons that have nothing to do with the line: a corner of the network
   * whose only exit is a one-way pointing in, a stub the importer clipped at
   * the box edge. Giving up there would refuse a line the player can see is
   * drivable, because they just drew it. Retracing asks the smaller question at
   * every junction instead of the whole-loop one at once, and answers it far
   * more often.
   */
  const back = pathToLane(net, lanes[lanes.length - 1], lanes[0], busPassable)
  if (back) {
    lanes.push(...back.lanes.slice(1))
    return { lanes, returnAt }
  }

  for (let i = nodes.length - 2; i >= 1; i--) {
    const leg = pathToNode(net, lanes[lanes.length - 1], nodes[i], busPassable)
    if (!leg) return null
    lanes.push(...leg.lanes.slice(1))
  }

  // The last hop closes the loop onto the lane it started on, not merely onto
  // the junction that lane leaves from.
  const closing = pathToLane(net, lanes[lanes.length - 1], lanes[0], busPassable)
  if (!closing) return null
  lanes.push(...closing.lanes.slice(1))

  return { lanes, returnAt }
}

/**
 * Place stops along a finished route: far side of every junction it passes,
 * thinned to a spacing floor.
 *
 * Automatic rather than authored. Placing every stop by hand is a second
 * drawing task on top of the first and adds nothing a player enjoys deciding —
 * where a stop *can* go is fixed by the geometry. What is worth deciding is
 * whether to keep one, and that is a click on an existing stop (`enabled`),
 * which is where the express-versus-local decision actually lives.
 */
export function buildRouteStops(
  net: Network,
  route: Pick<TransitRoute, 'id' | 'lanes'>,
  startId: StopId,
): TransitStop[] {
  const stops: TransitStop[] = []
  let nextId = startId
  const placed: { x: number; z: number }[] = []

  /**
   * @param spacing Relaxed on the second pass — see below.
   */
  const sweep = (spacing: number) => {
    for (let i = 0; i < route.lanes.length; i++) {
      const lane = net.lanes[route.lanes[i]]
      if (lane.kind !== 'road' || lane.fromNode === null) continue
      if (stops.some((s) => s.laneId === lane.id)) continue
      // No room to pull in and still clear the far end of the block.
      if (lane.length < MIN_STOP_BLOCK) continue

      const at = STOP_OFFSET_PAST_JUNCTION
      const p = samplePoly(laneToPoly(lane), at)
      if (placed.some((q) => dist(q.x, q.z, p.x, p.z) < spacing)) continue

      stops.push({
        id: nextId++,
        routeId: route.id,
        laneId: lane.id,
        laneS: at,
        legIndex: i,
        x: p.x,
        z: p.z,
        angle: Math.atan2(p.tx, p.tz),
        node: lane.fromNode,
        waiting: [],
        enabled: true,
      })
      placed.push({ x: p.x, z: p.z })
    }
  }

  sweep(MIN_STOP_SPACING)

  /*
   * A line with one stop is not a line — nobody can board it and alight
   * somewhere else, so it carries nobody however many buses are put on it, and
   * nothing on screen explains why. That happens on a short loop of short
   * blocks, where the spacing floor rejects every candidate after the first. So
   * the floor is relaxed rather than enforced: a stop pair too close together
   * is a poor line the player can see and redraw; a line with one stop is a
   * line that silently does not work.
   */
  if (stops.length < 2) sweep(MIN_STOP_BLOCK)

  return stops
}

// ---------------------------------------------------------------- the layer

/**
 * The transit network and its riders.
 *
 * Owned by the world and stepped from inside its fixed timestep, so a rider's
 * patience runs down at the same rate a bus crosses town however fast the game
 * is being played. Running it off the render loop instead would make the
 * service unplayable at 10x, which is the speed a player actually watches a
 * route settle at.
 */
export class Transit {
  readonly host: TransitHost
  readonly routes: TransitRoute[] = []
  destinations: Destination[] = []

  riders: Rider[] = []
  private freeRiders: RiderId[] = []

  /**
   * Every enabled stop, keyed by lane *and* route.
   *
   * Not by lane alone. Two lines that run a block of the same street have their
   * stops at the same point on the same lane, and a bus that treated the whole
   * lane's list as its own would open its doors at the other line's stop,
   * record that as the one it served, then find its own stop again — dwelling
   * for ever, one five-second interval at a time, without moving a metre.
   */
  private stopsByLaneRoute = new Map<string, TransitStop>()
  /** Every enabled stop by lane, for the renderer and for lane-wide questions. */
  private stopsByLane = new Map<LaneId, TransitStop[]>()
  private stopById = new Map<StopId, TransitStop>()

  /** Bus car ids, by route. */
  private busesByRoute = new Map<RouteId, number[]>()
  /** What each bus is carrying, by car id. */
  private load = new Map<number, RiderId[]>()

  /** Homes, sampled once from the street network. */
  private homes: { x: number; z: number }[] = []

  stats: TransitStats = {
    spawned: 0,
    delivered: 0,
    missed: 0,
    waiting: 0,
    riding: 0,
    walking: 0,
    unserved: 0,
    meanJourney: 0,
    meanWait: 0,
  }

  private journeyTotal = 0
  private waitTotal = 0

  /** Riders arriving per second across the whole map. */
  demand = 0.9

  private accum = 0
  private rand: () => number
  private nextStopId = TRANSIT_STOP_BASE
  private nextRouteNumber = 1

  /** Bumped whenever routes or stops change, so the renderer knows to rebuild. */
  version = 0

  constructor(host: TransitHost, seed: number) {
    this.host = host
    this.rand = mulberry32(seed ^ 0x7a11)
  }

  // ------------------------------------------------------------ destinations

  /**
   * Set the places people are going.
   *
   * Called by the renderer rather than derived here, because a destination has
   * to *be* a building the player can see, and which buildings exist is decided
   * by the scatter — surveyed outlines on an imported map, invented boxes
   * elsewhere. The simulation asking the renderer for this is the wrong way
   * round in principle and the only way to have the coloured building and the
   * place people walk to be the same object in practice.
   */
  setDestinations(sites: { x: number; z: number; building: number }[]): void {
    this.destinations = sites.map((s, i) => ({
      id: i,
      x: s.x,
      z: s.z,
      building: s.building,
      // The first destination is the downtown core and carries the most trips;
      // the tail are secondary and carry progressively fewer. A uniform split
      // makes every route equally good, which is the same failure the signal
      // game measured with uniform demand.
      weight: 1 / (1 + i * 0.45),
    }))
    this.version++
  }

  /**
   * Where people start their journeys.
   *
   * Junctions, jittered off the carriageway onto the pavement, weighted *away*
   * from the destinations: the far corners of the map are residential and the
   * middle is where the jobs are, which is the gradient every transit network
   * in the world is shaped by. Without it, homes and workplaces sit on top of
   * one another and no route is worth drawing.
   */
  setHomes(points: { x: number; z: number }[]): void {
    this.homes = points
    this.version++
  }

  // ----------------------------------------------------------------- routes

  /** Create a route from a list of clicked junctions. Null when it cannot be driven. */
  addRoute(nodes: NodeId[]): TransitRoute | null {
    const built = buildRouteLanes(this.host.net, nodes)
    if (!built) return null

    if (import.meta.env?.DEV && !chainIsContinuous(this.host.net, built.lanes)) {
      console.error('[transit] route chain is not continuous', nodes)
    }

    const id = `line-${this.nextRouteNumber}`
    const route: TransitRoute = {
      id,
      name: `Line ${this.nextRouteNumber}`,
      colour: this.routes.length,
      nodes: [...nodes],
      lanes: built.lanes,
      returnAt: built.returnAt,
      stops: [],
      buses: 0,
      running: 0,
      length: chainLength(this.host.net, built.lanes),
    }
    this.nextRouteNumber++

    route.stops = buildRouteStops(this.host.net, route, this.nextStopId)
    this.nextStopId += route.stops.length + 1

    this.routes.push(route)
    this.reindexStops()
    // Before the buses, not after: they are spawned onto lanes that have to be
    // simulated already, or the first one stands still until the camera finds it.
    this.host.regionChanged()
    this.setBuses(route.id, this.suggestedBuses(route))
    this.version++
    return route
  }

  removeRoute(id: RouteId): void {
    const at = this.routes.findIndex((r) => r.id === id)
    if (at < 0) return

    // Everyone standing at, riding toward, or riding on this line loses their
    // plan. They are put back on the pavement rather than deleted, so the
    // ledger stays honest: deleting a line strands people, and the score should
    // say so.
    for (const carId of this.busesByRoute.get(id) ?? []) {
      for (const riderId of this.load.get(carId) ?? []) this.strand(this.riders[riderId])
      this.load.delete(carId)
      this.host.despawnBus(carId)
    }
    this.busesByRoute.delete(id)

    for (const stop of this.routes[at].stops) {
      for (const riderId of stop.waiting) this.strand(this.riders[riderId])
    }

    this.routes.splice(at, 1)
    this.reindexStops()
    this.host.regionChanged()
    this.version++
  }

  /** How many buses a route needs for a bus every few minutes. */
  suggestedBuses(route: TransitRoute): number {
    // A bus averages maybe 7 m/s round a city loop once stops and lights are
    // paid for — well under its 10 m/s free-flow, and the difference is the
    // whole reason frequency is a decision. Aim for one every four minutes.
    const roundTrip = route.length / 7
    return Math.max(1, Math.min(12, Math.round(roundTrip / 240)))
  }

  setBuses(id: RouteId, count: number): void {
    const route = this.routes.find((r) => r.id === id)
    if (!route) return

    route.buses = Math.max(0, Math.min(20, Math.round(count)))
    this.fillFleet(route)
    this.version++
  }

  /** Bring a route's fleet up to (or down to) the number the player asked for. */
  private fillFleet(route: TransitRoute): void {
    const wanted = route.buses
    const running = this.busesByRoute.get(route.id) ?? []

    while (running.length > wanted) {
      const carId = running.pop()!
      for (const riderId of this.load.get(carId) ?? []) this.strand(this.riders[riderId])
      this.load.delete(carId)
      this.host.despawnBus(carId)
    }

    /*
     * New buses are spread round the loop rather than released from the
     * terminus together. A service whose whole fleet departs in the same second
     * arrives in the same second too, forever — the bunching every rider knows,
     * except that here nothing ever breaks it up, because there is no timetable
     * pulling them apart.
     */
    while (running.length < wanted) {
      const share = running.length / wanted
      const target = route.length * share
      const spawn = this.spawnPointAt(route, target)
      if (!spawn) break
      const carId = this.host.spawnBus(spawn.lanes, spawn.at, route.id, route.colour)
      // Refused because something is standing on the spawn point. Give up for
      // now rather than looping — the fleet sweep will try again in ten seconds,
      // by which time the street will have moved.
      if (carId === null) break
      running.push(carId)
      this.load.set(carId, [])
    }

    this.busesByRoute.set(route.id, running)
    route.running = running.length
  }

  /**
   * The lane chain a bus placed `target` metres round the loop should carry,
   * rotated so its own position is the start of it.
   *
   * Rotating rather than setting an index into a shared chain because the sim's
   * car model owns `route`/`routeIdx` and advances it linearly; a bus wraps by
   * having `loop` set, and it wraps to the beginning of *its* chain.
   */
  private spawnPointAt(
    route: TransitRoute,
    target: number,
  ): { lanes: LaneId[]; at: number } | null {
    const net = this.host.net
    let travelled = 0

    for (let i = 0; i < route.lanes.length; i++) {
      const lane = net.lanes[route.lanes[i]]
      if (travelled + lane.length >= target && lane.kind === 'road') {
        // Rotate the chain to start on this lane. Connectors are never a start
        // point: a bus materialising inside a junction box has no approach and
        // the conflict model has nothing to hold it back with.
        const lanes = [...route.lanes.slice(i), ...route.lanes.slice(0, i)]
        return { lanes, at: Math.min(target - travelled, lane.length * 0.8) }
      }
      travelled += lane.length
    }

    // Fell off the end (every candidate was a connector): start at the top.
    return { lanes: [...route.lanes], at: 0 }
  }

  /** Turn a stop on or off without redrawing the line. */
  toggleStop(id: StopId): void {
    const stop = this.stopById.get(id)
    if (!stop) return
    stop.enabled = !stop.enabled
    if (!stop.enabled) {
      for (const riderId of stop.waiting) this.strand(this.riders[riderId])
      stop.waiting.length = 0
    }
    this.reindexStops()
    this.version++
  }

  private reindexStops(): void {
    this.stopsByLane.clear()
    this.stopsByLaneRoute.clear()
    this.stopById.clear()
    for (const route of this.routes) {
      for (const stop of route.stops) {
        this.stopById.set(stop.id, stop)
        if (!stop.enabled) continue
        this.stopsByLaneRoute.set(key(stop.laneId, stop.routeId), stop)
        const list = this.stopsByLane.get(stop.laneId) ?? []
        list.push(stop)
        this.stopsByLane.set(stop.laneId, list)
      }
    }
  }

  /**
   * The stop on this lane that this bus should be watching for: its own line's,
   * and only if it has not already served it on this lap.
   *
   * The route is part of the question, not a filter applied to the answer. A
   * bus asking "is there a stop here" and getting somebody else's gets stuck at
   * it, because the id it records as served is not the id it will find next
   * time it looks.
   */
  stopFor(routeId: string | null, laneId: LaneId, servedStop: number): TransitStop | null {
    if (routeId === null) return null
    const stop = this.stopsByLaneRoute.get(key(laneId, routeId))
    if (!stop || stop.id === servedStop) return null
    return stop
  }

  /** Every enabled stop on a lane, whoever's line it belongs to. */
  stopsOnLane(laneId: LaneId): TransitStop[] | undefined {
    return this.stopsByLane.get(laneId)
  }

  stop(id: StopId): TransitStop | undefined {
    return this.stopById.get(id)
  }

  routeOf(id: RouteId): TransitRoute | undefined {
    return this.routes.find((r) => r.id === id)
  }

  // ----------------------------------------------------------------- riders

  /**
   * Put back any bus that has left the map.
   *
   * A bus can be towed after a collision like any other vehicle, and when one
   * is, the line quietly runs one bus short for the rest of the game with
   * nothing saying so — the stop it was due at simply stops being served. The
   * player never touched the fleet, so the fleet is what has to be restored.
   *
   * Not every tick: the check walks every bus, and a service losing a vehicle is
   * a once-an-hour event, not a once-a-frame one.
   */
  private replaceLostBuses(): void {
    for (const route of this.routes) {
      const running = this.busesByRoute.get(route.id)
      if (!running) continue

      for (let i = running.length - 1; i >= 0; i--) {
        if (this.host.carActive(running[i])) continue
        for (const riderId of this.load.get(running[i]) ?? []) this.strand(this.riders[riderId])
        this.load.delete(running[i])
        running.splice(i, 1)
      }

      if (running.length === route.buses) continue
      this.fillFleet(route)
      this.version++
    }
  }

  private sinceSweep = 0

  /** Fixed-timestep tick, called from the world's own. */
  tick(dt: number): void {
    this.sinceSweep += dt
    if (this.sinceSweep >= 10) {
      this.sinceSweep = 0
      this.replaceLostBuses()
    }

    this.spawnRiders(dt)

    let waiting = 0
    let riding = 0
    let walking = 0
    let unserved = 0

    for (const rider of this.riders) {
      if (!rider.active) continue
      rider.age += dt

      switch (rider.phase) {
        case 'unserved':
          /*
           * They stand there a while before giving up, and that is the point of
           * the phase rather than an accident of it: an unserved trip that
           * vanished on the tick it appeared would move the missed counter with
           * nothing on screen having explained why. A pip standing on a corner
           * that no line reaches is the map telling the player where to draw.
           */
          rider.waited += dt
          unserved++
          if (rider.waited >= UNSERVED_LINGER) this.retire(rider, 'missed')
          break

        case 'walking':
        case 'arriving': {
          rider.walked += WALK_SPEED * dt
          const t = rider.walkLength > 0 ? Math.min(1, rider.walked / rider.walkLength) : 1
          rider.x = rider.fromX + (rider.toX - rider.fromX) * t
          rider.z = rider.fromZ + (rider.toZ - rider.fromZ) * t
          walking++
          if (t < 1) break

          if (rider.phase === 'arriving') {
            this.retire(rider, 'delivered')
            break
          }
          // Arrived at the stop, joins the back of the queue.
          const stop = this.stopById.get(rider.boardStop)
          if (!stop || !stop.enabled) {
            this.strand(rider)
            break
          }
          rider.phase = 'waiting'
          stop.waiting.push(rider.id)
          break
        }

        case 'waiting': {
          rider.waited += dt
          waiting++
          if (rider.waited >= PATIENCE) {
            const stop = this.stopById.get(rider.boardStop)
            if (stop) {
              const at = stop.waiting.indexOf(rider.id)
              if (at >= 0) stop.waiting.splice(at, 1)
            }
            this.retire(rider, 'missed')
          }
          break
        }

        case 'riding':
          riding++
          break
      }
    }

    this.stats.waiting = waiting
    this.stats.riding = riding
    this.stats.walking = walking
    this.stats.unserved = unserved
  }

  /**
   * People decide to make a trip.
   *
   * Poisson-ish, at a rate that scales with how much city there is to serve, so
   * a five-block import and a whole borough both open with a service load
   * proportional to their size.
   */
  private spawnRiders(dt: number): void {
    if (this.destinations.length === 0 || this.homes.length === 0) return

    this.accum += dt * this.demand
    let budget = 40 // Never let a paused-then-resumed frame dump a crowd at once.

    while (this.accum >= 1 && budget-- > 0) {
      this.accum -= 1
      this.createRider()
    }
    if (budget <= 0) this.accum = 0
  }

  private createRider(): void {
    const home = this.homes[Math.floor(this.rand() * this.homes.length)]
    const destination = this.pickDestination(home)
    if (destination < 0) return

    const rider = this.take()
    rider.phase = 'walking'
    rider.destination = destination
    rider.homeX = home.x
    rider.homeZ = home.z
    rider.x = home.x
    rider.z = home.z
    rider.fromX = home.x
    rider.fromZ = home.z
    rider.age = 0
    rider.waited = 0
    rider.bus = -1
    rider.boardStop = -1
    rider.alightStop = -1

    this.stats.spawned++

    const plan = this.planTrip(home, this.destinations[destination])
    if (!plan) {
      rider.phase = 'unserved'
      rider.toX = home.x
      rider.toZ = home.z
      rider.walkLength = 0
      rider.walked = 0
      return
    }

    rider.boardStop = plan.board.id
    rider.alightStop = plan.alight.id
    rider.toX = plan.board.x
    rider.toZ = plan.board.z
    rider.walkLength = dist(home.x, home.z, plan.board.x, plan.board.z)
    rider.walked = 0
  }

  /**
   * Somewhere to go, weighted by attraction and against distance.
   *
   * Nobody buses three blocks and nobody walks across a borough; a trip is
   * chosen from the places that are far enough to be worth riding to and near
   * enough to be plausible. Without the near cut-off, half the demand is trips
   * whose two stops are the same one.
   */
  private pickDestination(home: { x: number; z: number }): number {
    let total = 0
    const weights = this.destinations.map((d) => {
      const away = dist(home.x, home.z, d.x, d.z)
      if (away < WALK_RADIUS) return 0
      // Gravity, softened: attraction over distance, not over distance squared,
      // because a city's job market is not a solar system and the squared form
      // sends every trip to whichever core happens to be nearest.
      const w = (d.weight * 1000) / away
      total += w
      return w
    })

    if (total <= 0) return -1
    let roll = this.rand() * total
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i]
      if (roll <= 0) return i
    }
    return weights.length - 1
  }

  /**
   * Find a single-seat ride from home to a destination.
   *
   * Over every route, the best pair of stops on it such that boarding is within
   * walking distance of home, alighting is within walking distance of the
   * destination, and the bus reaches the second from the first without going
   * round the loop again than it has to. Scored on total time, walking
   * included, so a stop a little further away on a much shorter ride wins —
   * which is how somebody actually chooses.
   */
  private planTrip(
    home: { x: number; z: number },
    to: Destination,
  ): { board: TransitStop; alight: TransitStop } | null {
    let best: { board: TransitStop; alight: TransitStop } | null = null
    let bestCost = Infinity

    for (const route of this.routes) {
      if (route.buses === 0) continue
      const stops = route.stops.filter((s) => s.enabled)
      if (stops.length < 2) continue

      for (const board of stops) {
        const walkOn = dist(home.x, home.z, board.x, board.z)
        if (walkOn > WALK_RADIUS) continue

        for (const alight of stops) {
          if (alight === board) continue
          const walkOff = dist(alight.x, alight.z, to.x, to.z)
          if (walkOff > WALK_RADIUS) continue

          // Riding distance round a loop: forward from board to alight,
          // wrapping past the end, which is what the bus will actually do.
          const ride = this.rideLength(route, board, alight)
          if (ride <= 0) continue

          // Half the loop of expected wait for the next bus, over the fleet.
          const headway = route.length / 7 / Math.max(1, route.buses)
          const cost = (walkOn + walkOff) / WALK_SPEED + ride / 7 + headway / 2

          if (cost < bestCost) {
            bestCost = cost
            best = { board, alight }
          }
        }
      }
    }

    return best
  }

  /** Metres a bus covers going from one stop to another the way round it drives. */
  private rideLength(route: TransitRoute, from: TransitStop, to: TransitStop): number {
    const net = this.host.net
    let total = 0
    let i = from.legIndex
    let guard = route.lanes.length + 1

    // From the boarding lane forward, wrapping, to the alighting lane.
    while (guard-- > 0) {
      const lane = net.lanes[route.lanes[i]]
      if (i === from.legIndex) total += lane.length - from.laneS
      else if (i === to.legIndex) return total + to.laneS
      else total += lane.length
      i = (i + 1) % route.lanes.length
      if (i === from.legIndex) break
    }
    return -1
  }

  // -------------------------------------------------------------- boarding

  /**
   * A bus has stopped at a stop with its doors open. Move people, and say how
   * long that takes.
   *
   * Called by the world at the moment it detects the bus has pulled up, and its
   * return value becomes the dwell — so a busy stop genuinely holds the traffic
   * behind it longer than a quiet one, which is both true and the thing that
   * makes a stop placement decision have a cost.
   */
  serviceStop(carId: number, stopId: StopId): number {
    const stop = this.stopById.get(stopId)
    if (!stop) return DWELL_MIN

    const aboard = this.load.get(carId) ?? []
    let moved = 0

    // Off first, as in life and for the same reason: a full bus cannot take
    // anybody until it has made room.
    for (let i = aboard.length - 1; i >= 0; i--) {
      const rider = this.riders[aboard[i]]
      if (!rider.active || rider.alightStop !== stopId) continue
      aboard.splice(i, 1)
      moved++

      const to = this.destinations[rider.destination]
      rider.phase = 'arriving'
      rider.bus = -1
      rider.fromX = stop.x
      rider.fromZ = stop.z
      rider.toX = to.x
      rider.toZ = to.z
      rider.x = stop.x
      rider.z = stop.z
      rider.walked = 0
      rider.walkLength = dist(stop.x, stop.z, to.x, to.z)
    }

    // Then on, in the order they arrived, until the bus is full.
    while (stop.waiting.length > 0 && aboard.length < BUS_CAPACITY) {
      const riderId = stop.waiting[0]
      const rider = this.riders[riderId]
      if (!rider.active || rider.phase !== 'waiting') {
        stop.waiting.shift()
        continue
      }
      /*
       * Only the line they planned for. A rider who boards whatever turns up
       * would ride to a stop nowhere near their destination and then be
       * stranded, and since there are no transfers there is nothing to strand
       * them onto — so the check is what keeps the no-transfer simplification
       * honest rather than merely absent.
       */
      if (rider.boardStop !== stopId) break

      stop.waiting.shift()
      aboard.push(riderId)
      rider.phase = 'riding'
      rider.bus = carId
      moved++
    }

    this.load.set(carId, aboard)

    const dwell = DWELL_BASE + moved * DWELL_PER_RIDER
    return Math.max(DWELL_MIN, Math.min(DWELL_MAX, dwell))
  }

  /** How many people are on a bus, for the renderer and the HUD. */
  loadOf(carId: number): number {
    return this.load.get(carId)?.length ?? 0
  }

  /** Riders on board follow the bus, so they are drawn where it is. */
  syncRiding(): void {
    const pose = { x: 0, z: 0, angle: 0 }
    for (const [carId, aboard] of this.load) {
      if (!this.host.carPose(carId, pose)) continue
      for (const riderId of aboard) {
        const rider = this.riders[riderId]
        rider.x = pose.x
        rider.z = pose.z
      }
    }
  }

  /**
   * A bus vanished under a rider — the line was deleted, or the vehicle was
   * towed after a crash. They are put back on the pavement where the bus was,
   * and counted as missed: a journey that ended somewhere the rider did not
   * choose is not a journey served.
   */
  private strand(rider: Rider | undefined): void {
    if (!rider || !rider.active) return
    this.retire(rider, 'missed')
  }

  private take(): Rider {
    const reused = this.freeRiders.pop()
    if (reused !== undefined) {
      const rider = this.riders[reused]
      rider.active = true
      return rider
    }
    const rider: Rider = {
      id: this.riders.length,
      active: true,
      phase: 'walking',
      destination: 0,
      homeX: 0,
      homeZ: 0,
      x: 0,
      z: 0,
      fromX: 0,
      fromZ: 0,
      toX: 0,
      toZ: 0,
      walked: 0,
      walkLength: 0,
      boardStop: -1,
      alightStop: -1,
      age: 0,
      waited: 0,
      bus: -1,
    }
    this.riders.push(rider)
    return rider
  }

  private retire(rider: Rider, how: 'delivered' | 'missed'): void {
    if (!rider.active) return
    rider.active = false
    this.freeRiders.push(rider.id)

    if (rider.bus >= 0) {
      const aboard = this.load.get(rider.bus)
      if (aboard) {
        const at = aboard.indexOf(rider.id)
        if (at >= 0) aboard.splice(at, 1)
      }
      rider.bus = -1
    }

    if (how === 'missed') {
      this.stats.missed++
      return
    }

    this.stats.delivered++
    this.journeyTotal += rider.age
    this.waitTotal += rider.waited
    this.stats.meanJourney = this.journeyTotal / this.stats.delivered
    this.stats.meanWait = this.waitTotal / this.stats.delivered
  }

  /**
   * The ledger, for the dev harness.
   *
   * Everybody who ever appeared is either on the map somewhere or accounted
   * for. This is the transit equivalent of the world's spawned = delivered +
   * retired + active check, and it exists for the same reason: a rider quietly
   * leaking out of the model is invisible on screen and shows up only as a
   * service that mysteriously never gets busy.
   */
  ledgerBalances(): boolean {
    let live = 0
    for (const rider of this.riders) if (rider.active) live++
    return this.stats.spawned === this.stats.delivered + this.stats.missed + live
  }
}

/**
 * Pick homes off the street network.
 *
 * Every junction is a candidate; the ones far from a destination are more
 * likely, which is what gives the map a residential edge and a working middle.
 * Exported so the renderer can seed it from the same level the buildings came
 * from and the two agree about where the city is.
 */
export function sampleHomes(
  net: Network,
  nodes: { id: NodeId; pos: [number, number]; kind: string }[],
  destinations: { x: number; z: number }[],
  count: number,
  seed: number,
): { x: number; z: number }[] {
  const rand = mulberry32(seed ^ 0x40de)
  const candidates = nodes.filter((n) => n.kind === 'junction' && lanesLeaving(net, n.id).length > 0)
  if (candidates.length === 0) return []

  const weights = candidates.map((n) => {
    if (destinations.length === 0) return 1
    let nearest = Infinity
    for (const d of destinations) {
      nearest = Math.min(nearest, dist(n.pos[0], n.pos[1], d.x, d.z))
    }
    // Flat inside a walk of a destination — those people have no trip to make —
    // and rising with distance out to the edge of the map.
    return nearest < WALK_RADIUS ? 0.15 : 1 + nearest / 1500
  })

  const total = weights.reduce((a, b) => a + b, 0)
  const homes: { x: number; z: number }[] = []

  for (let i = 0; i < count; i++) {
    let roll = rand() * total
    let pick = candidates.length - 1
    for (let j = 0; j < candidates.length; j++) {
      roll -= weights[j]
      if (roll <= 0) {
        pick = j
        break
      }
    }
    const node = candidates[pick]
    // Off the carriageway, onto a corner. Jittered so a hundred homes on forty
    // junctions do not stack into forty pillars of people.
    const angle = rand() * Math.PI * 2
    const away = 14 + rand() * 20
    homes.push({
      x: node.pos[0] + Math.cos(angle) * away,
      z: node.pos[1] + Math.sin(angle) * away,
    })
  }

  return homes
}
