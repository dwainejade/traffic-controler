import {
  cycleOf,
  greenTotal,
  type Junction,
  type Program,
  type Timing,
} from "./junction";
import { IDM } from "./idm";
import { polyLength, roadCentreline } from "./centreline";
import type { Network } from "./network";
import type { LevelDef, NodeId } from "./types";

/**
 * A set of junctions running on a common cycle.
 *
 * The one binding constraint of coordination is the **cycle length**: junctions
 * on different cycles drift apart and no stable green wave can exist. Splits and
 * offsets are free to differ per member, which is exactly how real coordinated
 * corridors are run — a common cycle, local splits, individual offsets.
 */
export type SignalGroup = {
  id: string;
  name: string;
  members: NodeId[];
  /** Parent program. Its total green time is binding on every member. */
  parent: Program;
  /** Start delay within the cycle, per member. This is what makes a wave. */
  offsets: Map<NodeId, number>;
  /** Per-member split override — the "subprogram". Same total, different shape. */
  overrides: Map<NodeId, number[]>;
};

/** The program a junction is actually running right now. */
export function resolveProgram(
  junction: Junction,
  group: SignalGroup | undefined,
): Program {
  if (!group) return junction.program;
  const override = group.overrides.get(junction.nodeId);
  return override ? { splits: override } : group.parent;
}

/**
 * Rescale a set of splits to a new total green time, preserving their shape.
 * Used to fit a junction's own program onto a group's cycle when it joins, and
 * to keep an override honest when the parent cycle changes.
 */
export function fitToTotal(splits: number[], total: number): number[] {
  const current = splits.reduce((a, b) => a + Math.max(0, b), 0);
  if (current <= 0) {
    return new Array(splits.length).fill(total / Math.max(1, splits.length));
  }
  const scale = total / current;
  return splits.map((s) => Math.max(0, s) * scale);
}

/**
 * Move `seconds` of green from one phase to another, keeping the cycle length
 * fixed. This is the operation a draggable split bar performs.
 */
export function shiftSplit(
  splits: number[],
  index: number,
  seconds: number,
  minGreen: number,
): number[] {
  const next = splits.slice();
  const partner = index + 1;
  if (partner >= splits.length) return next;

  // Clamp so neither side drops below the minimum servable green.
  const lower = minGreen - next[index];
  const upper = next[partner] - minGreen;
  const delta = Math.max(lower, Math.min(upper, seconds));

  next[index] += delta;
  next[partner] -= delta;
  return next;
}

let nextGroupId = 1;

export function createGroup(members: NodeId[], parent: Program): SignalGroup {
  return {
    id: `g${nextGroupId++}`,
    name: `Group ${nextGroupId - 1}`,
    members: [...members],
    parent: { splits: [...parent.splits] },
    offsets: new Map(members.map((m) => [m, 0])),
    overrides: new Map(),
  };
}

/**
 * Offsets that produce a green wave: each junction opens its cycle one travel
 * time later than the one before it, so a platoon released by the first arrives
 * at each subsequent junction just as it turns green.
 *
 * Distances are walked outward from a reference member over the road graph, so
 * this works on any connected group rather than only a straight corridor.
 */
export function autoOffsets(
  level: LevelDef,
  _net: Network,
  group: SignalGroup,
  timing: Timing,
  speed: number = IDM.v0,
): void {
  if (group.members.length === 0) return;

  const cycle = cycleOf(group.parent, timing);

  // Adjacency between group members that share a road, with the *driven*
  // distance between them. On a curved road the chord understates travel time
  // and the wave arrives before the platoon does.
  const neighbours = new Map<NodeId, { id: NodeId; dist: number }[]>();
  for (const id of group.members) neighbours.set(id, []);
  for (const road of level.roads) {
    const { from, to } = road;
    if (!neighbours.has(from) || !neighbours.has(to)) continue;
    const dist = polyLength(roadCentreline(level, road));
    neighbours.get(from)!.push({ id: to, dist });
    neighbours.get(to)!.push({ id: from, dist });
  }

  const root = group.members[0];
  const distance = new Map<NodeId, number>([[root, 0]]);
  const queue: NodeId[] = [root];

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const next of neighbours.get(current) ?? []) {
      if (distance.has(next.id)) continue;
      distance.set(next.id, distance.get(current)! + next.dist);
      queue.push(next.id);
    }
  }

  for (const id of group.members) {
    const d = distance.get(id) ?? 0;
    group.offsets.set(id, (d / speed) % cycle);
  }
}

/** Total green a member must divide up to stay on the group's cycle. */
export function groupGreenTotal(group: SignalGroup): number {
  return greenTotal(group.parent);
}
