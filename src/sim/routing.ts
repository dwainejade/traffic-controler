import type { Lane, LaneId, Network } from "./network";
import type { NodeId } from "./types";

/**
 * Distance-to-destination tables over the lane graph.
 *
 * Cars pick an origin/destination pair on spawn and follow the cheapest chain of
 * movements to get there. Routing this way rather than turning at random keeps
 * flows coherent across a grid and — importantly — guarantees every car
 * terminates instead of circling the block forever.
 */
export type RoutingTables = {
  /** Map-edge nodes cars can be sent to. */
  destinations: NodeId[];
  /** `cost.get(dest)[laneId]` = lanes remaining to reach dest, or Infinity. */
  cost: Map<NodeId, Float64Array>;
};

/** Lanes reachable in one movement from a road lane, via its connectors. */
function successors(net: Network, laneId: LaneId): LaneId[] {
  const lane = net.lanes[laneId];
  if (lane.kind === "connector") return lane.next;
  return lane.next.map((c) => net.lanes[c].next[0]).filter((id) => id !== undefined);
}

/**
 * @param allow Which lanes this class of vehicle may use. Absent, all of them.
 *
 * The filter is how a truck is kept off the residential grid: it is not a
 * penalty a driver might decide to pay, it is an edge that does not exist, so a
 * truck route through a side street cannot be built at all. That is also how the
 * real rule works — a through-truck route is a legal restriction, not a
 * preference.
 *
 * `destinations` is deliberately *not* filtered. Every class shares one list, in
 * one order, so the world's per-destination attraction weights stay aligned
 * across all of them; a destination a truck cannot reach simply has infinite
 * cost everywhere, and the spawn loop discards that draw and tries again.
 */
export function buildRouting(
  net: Network,
  allow?: (lane: Lane) => boolean,
): RoutingTables {
  const passable = (id: LaneId) => allow === undefined || allow(net.lanes[id]);

  const destinations: NodeId[] = [];
  for (const id of net.exitLanes) {
    const node = net.lanes[id].toNode;
    if (node && !destinations.includes(node)) destinations.push(node);
  }

  // Reverse adjacency, so a single BFS from each destination costs one pass.
  const incoming = new Map<LaneId, LaneId[]>();
  for (const lane of net.lanes) {
    if (lane.kind !== "road" || !passable(lane.id)) continue;
    for (const succ of successors(net, lane.id)) {
      if (!passable(succ)) continue;
      const list = incoming.get(succ) ?? [];
      list.push(lane.id);
      incoming.set(succ, list);
    }
  }

  const cost = new Map<NodeId, Float64Array>();

  for (const dest of destinations) {
    const dist = new Float64Array(net.lanes.length).fill(Infinity);
    const queue: LaneId[] = [];

    for (const id of net.exitLanes) {
      if (net.lanes[id].toNode !== dest || !passable(id)) continue;
      dist[id] = 0;
      queue.push(id);
    }

    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      for (const prev of incoming.get(current) ?? []) {
        if (dist[prev] !== Infinity) continue;
        dist[prev] = dist[current] + 1;
        queue.push(prev);
      }
    }

    cost.set(dest, dist);
  }

  return { destinations, cost };
}

/**
 * Ceiling on how many movements a route may take, purely as a guard against a
 * cycle in the cost table sending the walk round forever.
 *
 * It was 64, which is a generous crossing of a single junction's worth of map
 * and nowhere near a crossing of a city. On a 5km grid an edge-to-edge route is
 * several hundred lanes, so every long trip hit the guard and came back null —
 * the spawn was silently discarded, and the network could not load past a few
 * hundred cars however high demand went. The failure was invisible: no error,
 * just a city that stayed empty.
 *
 * High enough now that only a genuine cycle reaches it. Each step is one array
 * lookup, and this runs once per spawn, not per frame.
 */
const MAX_ROUTE_LANES = 2000;

/**
 * Build a full lane-by-lane route from a starting lane to a destination.
 * Returns null when the destination is unreachable from here.
 */
export function routeTo(
  net: Network,
  tables: RoutingTables,
  start: LaneId,
  dest: NodeId,
  rand: () => number,
): LaneId[] | null {
  const dist = tables.cost.get(dest);
  if (!dist || dist[start] === Infinity) return null;

  const route: LaneId[] = [start];
  let lane = start;
  let guard = 0;

  while (net.lanes[lane].toNode !== dest) {
    if (++guard > MAX_ROUTE_LANES) return null;

    // Among the movements available, take one that gets strictly closer.
    let best: { connector: LaneId; target: LaneId }[] = [];
    let bestCost = Infinity;

    for (const connector of net.lanes[lane].next) {
      const target = net.lanes[connector].next[0];
      if (target === undefined) continue;
      const c = dist[target];
      if (c < bestCost) {
        bestCost = c;
        best = [{ connector, target }];
      } else if (c === bestCost) {
        best.push({ connector, target });
      }
    }

    if (best.length === 0 || bestCost === Infinity) return null;

    // Ties are common on a grid — a random pick spreads load over both routes.
    const pick = best[Math.floor(rand() * best.length)];
    route.push(pick.connector, pick.target);
    lane = pick.target;
  }

  return route;
}
