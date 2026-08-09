import type { LaneId, Network } from "./network";
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

export function buildRouting(net: Network): RoutingTables {
  const destinations: NodeId[] = [];
  for (const id of net.exitLanes) {
    const node = net.lanes[id].toNode;
    if (node && !destinations.includes(node)) destinations.push(node);
  }

  // Reverse adjacency, so a single BFS from each destination costs one pass.
  const incoming = new Map<LaneId, LaneId[]>();
  for (const lane of net.lanes) {
    if (lane.kind !== "road") continue;
    for (const succ of successors(net, lane.id)) {
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
      if (net.lanes[id].toNode !== dest) continue;
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
    if (++guard > 64) return null;

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
