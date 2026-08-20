/**
 * Point-to-point routing over the lane graph.
 *
 * `routing.ts` answers a different question: it precomputes, for every map-edge
 * destination, the cost from every lane, because a car picks its destination
 * once at spawn and never changes its mind. A bus route is drawn a junction at
 * a time by a player, so the query is "cheapest legal chain of movements from
 * *here* to *that* junction" for an arbitrary pair — and there are as many pairs
 * as there are junctions squared, which is not a table worth building.
 *
 * So this is an ordinary Dijkstra, run per click. On a 400-junction city that is
 * a few thousand lanes and lands well under a frame; it is the player's hand
 * that sets the rate, not the simulation's.
 */

import type { Lane, LaneId, Network } from './network'
import type { NodeId } from './types'

/** A drawn segment: the lane chain, and how long it is on the ground. */
export type LanePath = {
  /** Road lanes and the connectors between them, alternating, in travel order. */
  lanes: LaneId[]
  /** Metres. */
  length: number
}

/**
 * The road lanes a vehicle may leave `node` on.
 *
 * Road lanes only — a connector is the *movement* through a junction and never
 * a place a route starts, because starting inside a junction box would leave the
 * first bus with no approach to it.
 */
export function lanesLeaving(net: Network, node: NodeId, allow?: (l: Lane) => boolean): LaneId[] {
  const out: LaneId[] = []
  for (const lane of net.lanes) {
    if (lane.kind !== 'road' || lane.fromNode !== node) continue
    if (allow && !allow(lane)) continue
    out.push(lane.id)
  }
  return out
}

/**
 * Cheapest chain of lanes from a starting road lane to any road lane arriving at
 * `to`, or null when the junction cannot be reached under `allow`.
 *
 * The chain includes the connectors, so it is exactly the shape `Car.route`
 * wants and can be concatenated with the next segment without a join step —
 * provided the next segment starts from the lane this one ended on, which is
 * what `startLane` is for.
 */
export function pathToNode(
  net: Network,
  startLane: LaneId,
  to: NodeId,
  allow?: (l: Lane) => boolean,
): LanePath | null {
  const passable = (id: LaneId) => allow === undefined || allow(net.lanes[id])
  if (!passable(startLane)) return null

  if (net.lanes[startLane].toNode === to) {
    return { lanes: [startLane], length: net.lanes[startLane].length }
  }

  const dist = new Map<LaneId, number>([[startLane, 0]])
  /** How each lane was reached: the road lane before it and the connector used. */
  const prev = new Map<LaneId, { lane: LaneId; via: LaneId }>()
  const seen = new Set<LaneId>()

  /*
   * A binary heap would be the textbook answer and is not worth the code here:
   * the frontier on a street network stays in the low hundreds, and a linear
   * scan over it is faster than the allocation a heap of boxed entries costs.
   */
  const frontier: LaneId[] = [startLane]

  while (frontier.length > 0) {
    let bestAt = 0
    for (let i = 1; i < frontier.length; i++) {
      if ((dist.get(frontier[i]) ?? Infinity) < (dist.get(frontier[bestAt]) ?? Infinity)) bestAt = i
    }
    const current = frontier.splice(bestAt, 1)[0]
    if (seen.has(current)) continue
    seen.add(current)

    const lane = net.lanes[current]
    if (lane.toNode === to) return rebuild(net, prev, startLane, current)

    const base = dist.get(current) ?? Infinity

    for (const connector of lane.next) {
      if (!passable(connector)) continue
      const target = net.lanes[connector].next[0]
      if (target === undefined || !passable(target)) continue

      const cost = base + net.lanes[connector].length + net.lanes[target].length
      if (cost >= (dist.get(target) ?? Infinity)) continue

      dist.set(target, cost)
      prev.set(target, { lane: current, via: connector })
      frontier.push(target)
    }
  }

  return null
}

function rebuild(
  net: Network,
  prev: Map<LaneId, { lane: LaneId; via: LaneId }>,
  start: LaneId,
  end: LaneId,
): LanePath {
  const lanes: LaneId[] = [end]
  let at = end
  while (at !== start) {
    const step = prev.get(at)
    if (!step) break
    lanes.unshift(step.lane, step.via)
    at = step.lane
  }

  let length = 0
  for (const id of lanes) length += net.lanes[id].length
  return { lanes, length }
}

/**
 * Cheapest chain from a lane to a *specific* lane, excluding the target itself.
 *
 * This is what closing a loop needs, and reaching the target's junction is not
 * the same question: a bus that arrives at the junction the route starts from
 * has still not necessarily arrived on a lane with a legal movement onto the
 * first lane of the route. Ask for the node and the loop can end one connector
 * short of closing, at which point a bus wrapping from the end of its chain to
 * the start teleports across the junction — which looks like a rendering
 * glitch and is not.
 */
export function pathToLane(
  net: Network,
  startLane: LaneId,
  target: LaneId,
  allow?: (l: Lane) => boolean,
): LanePath | null {
  const passable = (id: LaneId) => allow === undefined || allow(net.lanes[id])
  if (!passable(startLane) || !passable(target)) return null

  const dist = new Map<LaneId, number>([[startLane, 0]])
  const prev = new Map<LaneId, { lane: LaneId; via: LaneId }>()
  const seen = new Set<LaneId>()
  const frontier: LaneId[] = [startLane]

  while (frontier.length > 0) {
    let bestAt = 0
    for (let i = 1; i < frontier.length; i++) {
      if ((dist.get(frontier[i]) ?? Infinity) < (dist.get(frontier[bestAt]) ?? Infinity)) bestAt = i
    }
    const current = frontier.splice(bestAt, 1)[0]
    if (seen.has(current)) continue
    seen.add(current)

    const lane = net.lanes[current]
    const base = dist.get(current) ?? Infinity

    for (const connector of lane.next) {
      if (!passable(connector)) continue
      const next = net.lanes[connector].next[0]
      if (next === undefined || !passable(next)) continue

      /*
       * Reaching the target is the answer, and the connector onto it comes back
       * with the chain while the target lane itself does not: the caller
       * already has that lane as the first entry of the loop, and returning it
       * twice would put a duplicate at the join.
       */
      if (next === target) {
        const path = rebuild(net, prev, startLane, current)
        path.lanes.push(connector)
        path.length += net.lanes[connector].length
        return path
      }

      const cost = base + net.lanes[connector].length + net.lanes[next].length
      if (cost >= (dist.get(next) ?? Infinity)) continue

      dist.set(next, cost)
      prev.set(next, { lane: current, via: connector })
      frontier.push(next)
    }
  }

  return null
}

/**
 * Cheapest chain from a junction to a junction, free to leave on any lane.
 *
 * Used for the first segment of a route and for the return leg, where nothing
 * upstream constrains which lane the bus is in. Everywhere else the caller has a
 * lane it must continue from and wants `pathToNode`.
 */
export function pathBetween(
  net: Network,
  from: NodeId,
  to: NodeId,
  allow?: (l: Lane) => boolean,
): LanePath | null {
  let best: LanePath | null = null
  for (const start of lanesLeaving(net, from, allow)) {
    const path = pathToNode(net, start, to, allow)
    if (path && (best === null || path.length < best.length)) best = path
  }
  return best
}

/**
 * Whether a lane chain is actually drivable: road, connector, road, connector,
 * road… with every link declared by the graph rather than merely adjacent.
 *
 * Cheap, and worth running in dev on every route the player closes. A chain with
 * one bad join does not throw — the bus simply teleports across the gap at the
 * end of the lane, which looks like a rendering glitch and is not.
 */
export function chainIsContinuous(net: Network, lanes: LaneId[]): boolean {
  for (let i = 0; i + 1 < lanes.length; i++) {
    if (!net.lanes[lanes[i]].next.includes(lanes[i + 1])) return false
  }
  return true
}

/** Total ground length of a lane chain, metres. */
export function chainLength(net: Network, lanes: LaneId[]): number {
  let total = 0
  for (const id of lanes) total += net.lanes[id].length
  return total
}
