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
 * Walk the predecessor table back into a lane chain.
 *
 * The chain alternates road, connector, road… because that is what the
 * predecessor records: which road lane we came from and which movement we took.
 */
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
 * The cheapest chain from `startLane` to *every* lane that arrives at `to`.
 *
 * Not the same as `pathToNode`, which returns only the cheapest of them, and
 * the difference is what makes a drawn line buildable. Which lane a bus arrives
 * on decides which movements it can make next, so taking the shortest way to a
 * junction can leave it facing a direction the rest of the route cannot be
 * driven from. Handing back all the arrivals lets the caller keep every option
 * open and pick one that works for the whole loop rather than for one leg.
 */
export function pathsToNode(
  net: Network,
  startLane: LaneId,
  to: NodeId,
  allow?: (l: Lane) => boolean,
): LanePath[] {
  const passable = (id: LaneId) => allow === undefined || allow(net.lanes[id])
  if (!passable(startLane)) return []

  const dist = new Map<LaneId, number>([[startLane, 0]])
  const prev = new Map<LaneId, { lane: LaneId; via: LaneId }>()
  const seen = new Set<LaneId>()
  const frontier: LaneId[] = [startLane]
  const arrivals: LaneId[] = []

  if (net.lanes[startLane].toNode === to) arrivals.push(startLane)

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
      const target = net.lanes[connector].next[0]
      if (target === undefined || !passable(target)) continue

      const cost = base + net.lanes[connector].length + net.lanes[target].length
      if (cost >= (dist.get(target) ?? Infinity)) continue

      dist.set(target, cost)
      prev.set(target, { lane: current, via: connector })
      frontier.push(target)
      if (net.lanes[target].toNode === to && !arrivals.includes(target)) arrivals.push(target)
    }
  }

  return arrivals.map((id) => rebuild(net, prev, startLane, id))
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
 * Check a lane chain is actually drivable: road, connector, road, connector,
 * road… with every link declared by the graph rather than merely adjacent.
 *
 * Returns the index of the first bad join, or -1 when the chain is sound.
 *
 * Cheap, and worth running in dev on every route the player closes. A chain with
 * one bad join does not throw — the bus simply teleports across the gap at the
 * end of the lane, which looks like a rendering glitch and is not.
 *
 * @param hopAt One index that is allowed to break, because the route says the
 * bus turns round there rather than driving through. Everything else must join.
 */
export function chainIsContinuous(net: Network, lanes: LaneId[], hopAt = -1): number {
  for (let i = 0; i + 1 < lanes.length; i++) {
    if (i + 1 === hopAt) continue
    if (!net.lanes[lanes[i]].next.includes(lanes[i + 1])) return i
  }
  return -1
}

/** Total ground length of a lane chain, metres. */
export function chainLength(net: Network, lanes: LaneId[]): number {
  let total = 0
  for (const id of lanes) total += net.lanes[id].length
  return total
}

/**
 * The same stretch of road, in the other direction.
 *
 * Built as a table because the question is asked for every lane of a route and
 * the answer is a scan over the network. Lanes pair by road and by index: the
 * outbound lane 0 of a road pairs with its backward lane 0, which is the lane
 * directly across the centreline from it.
 */
export function oppositeLanes(net: Network): Map<LaneId, LaneId> {
  const byRoad = new Map<string, Lane[]>()
  for (const lane of net.lanes) {
    if (lane.kind !== 'road' || lane.roadId === null) continue
    const list = byRoad.get(lane.roadId) ?? []
    list.push(lane)
    byRoad.set(lane.roadId, list)
  }

  const opposite = new Map<LaneId, LaneId>()
  for (const lanes of byRoad.values()) {
    for (const lane of lanes) {
      const other = lanes.find(
        (l) =>
          l.id !== lane.id &&
          l.index === lane.index &&
          l.fromNode === lane.toNode &&
          l.toNode === lane.fromNode,
      )
      if (other) opposite.set(lane.id, other.id)
    }
  }
  return opposite
}

/**
 * The way back along a path already driven: the same roads, the other side of
 * the street, in reverse order.
 *
 * This is what a bus line is when there is no circuit to run — which on a real
 * street network is most of them. The turn at the far end is not a movement any
 * junction offers, so it is not asked for: the caller stands the bus still for
 * a layover and it sets off facing the other way, exactly as a bus at the end
 * of the line does.
 *
 * Returns null when any leg of the outbound path is one-way, since there is
 * then no other side of that street to come back on and the line genuinely has
 * to loop.
 */
export function reversePath(
  net: Network,
  outbound: LaneId[],
  opposite: Map<LaneId, LaneId>,
  allow?: (l: Lane) => boolean,
): LanePath | null {
  const roads = outbound.filter((id) => net.lanes[id].kind === 'road')
  if (roads.length === 0) return null

  const back: LaneId[] = []
  for (let i = roads.length - 1; i >= 0; i--) {
    const other = opposite.get(roads[i])
    if (other === undefined) return null
    if (allow && !allow(net.lanes[other])) return null
    back.push(other)
  }

  // Stitch: consecutive reversed lanes meet at a junction, and the movement
  // between them is an ordinary one the junction offers — but it is not always
  // a straight-through, so it is looked up rather than assumed.
  const chain: LaneId[] = [back[0]]
  for (let i = 1; i < back.length; i++) {
    const leg = pathToLane(net, chain[chain.length - 1], back[i], allow)
    if (!leg) return null
    chain.push(...leg.lanes.slice(1), back[i])
  }

  let length = 0
  for (const id of chain) length += net.lanes[id].length
  return { lanes: chain, length }
}
