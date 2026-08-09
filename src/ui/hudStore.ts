import { create } from "zustand";
import type { FailReason, GameState, World } from "../sim/world";
import type { SignalState } from "../sim/junction";
import type { NodeId } from "../sim/types";

export type JunctionHud = {
  id: NodeId;
  phases: string[];
  current: number;
  signal: SignalState;
  /** Cars waiting on all approaches, for the at-a-glance pressure readout. */
  queue: number;
  /** Green seconds per phase — the program this junction is actually running. */
  splits: number[];
  cycle: number;
  offset: number;
  groupId: string | null;
  /** True when this member deviates from its group's parent program. */
  hasOverride: boolean;
};

export type GroupHud = {
  id: string;
  name: string;
  members: NodeId[];
  cycle: number;
};

/**
 * The HUD's mirror of simulation state. The sim itself never lives in React —
 * this is written a few times a second, not every frame.
 */
export type HudState = {
  delivered: number;
  active: number;
  elapsed: number;
  meanWait: number;
  junctions: JunctionHud[];
  groups: GroupHud[];
  /** Player's current junction. UI-owned: publishHud must never overwrite it. */
  selected: NodeId | null;
  /** While true, clicking junctions adds them to `linkSelection`. UI-owned. */
  linking: boolean;
  linkSelection: NodeId[];
  /** Time multiplier. UI-owned. 0 pauses. */
  speed: number;
  observing: boolean;
  collisions: number;
  /** Cars per second arriving, mirrored from the world so the sandbox can tune it. */
  demand: number;
  state: GameState;
  failReason: FailReason;
  quota: number;
  timeLeft: number;
};

export const useHud = create<HudState>(() => ({
  delivered: 0,
  active: 0,
  elapsed: 0,
  meanWait: 0,
  junctions: [],
  groups: [],
  selected: null,
  linking: false,
  linkSelection: [],
  speed: 1,
  observing: false,
  collisions: 0,
  demand: 1,
  state: "running",
  failReason: null,
  quota: 0,
  timeLeft: 0,
}));

export function selectJunction(id: NodeId): void {
  const { linking, linkSelection } = useHud.getState();

  // While linking, a click toggles membership of the set being built rather
  // than moving the editor's focus.
  if (linking) {
    useHud.setState({
      linkSelection: linkSelection.includes(id)
        ? linkSelection.filter((m) => m !== id)
        : [...linkSelection, id],
    });
    return;
  }
  useHud.setState({ selected: id });
}

export function startLinking(seed: NodeId | null): void {
  useHud.setState({ linking: true, linkSelection: seed ? [seed] : [] });
}

export function cancelLinking(): void {
  useHud.setState({ linking: false, linkSelection: [] });
}

/** Available time multiples. 0 is pause. */
export const SPEEDS = [0, 1, 2, 5, 20, 100] as const;

export function setSpeed(speed: number): void {
  useHud.setState({ speed });
}

export function nudgeSpeed(direction: 1 | -1): void {
  const current = useHud.getState().speed;
  const i = SPEEDS.indexOf(current as (typeof SPEEDS)[number]);
  const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 1 : i) + direction))];
  useHud.setState({ speed: next });
}

// Debug handle: the HUD is only written from the render loop, so this is the
// way to exercise result and failure screens without waiting for a real run.
if (import.meta.env.DEV) {
  Object.assign(globalThis, { hudStore: useHud });
}

export function publishHud(world: World): void {
  const junctions: JunctionHud[] = [];

  const groups: GroupHud[] = [...world.groups.values()].map((g) => ({
    id: g.id,
    name: g.name,
    members: [...g.members],
    cycle: world.cycleFor(g.members[0]),
  }));

  for (const [id, j] of world.junctions) {
    let queue = 0;
    for (const arm of world.net.armsByJunction.get(id) ?? []) {
      for (const laneId of arm.inbound) {
        queue += world.net.lanes[laneId].cars.length;
      }
    }

    junctions.push({
      id,
      phases: j.phases.map((p) => p.name),
      current: j.current,
      signal: j.state,
      queue,
      splits: [...world.programOf(j).splits],
      cycle: world.cycleFor(id),
      offset: j.offset,
      groupId: j.groupId,
      hasOverride: j.groupId
        ? (world.groups.get(j.groupId)?.overrides.has(id) ?? false)
        : false,
    });
  }

  const previous = useHud.getState();

  useHud.setState({
    delivered: world.stats.delivered,
    active: world.stats.active,
    elapsed: world.stats.elapsed,
    meanWait: world.stats.meanWait,
    junctions,
    groups,
    // Default the selection once, then leave it to the player.
    selected: previous.selected ?? junctions[0]?.id ?? null,
    observing: world.observing,
    collisions: world.stats.collisions,
    demand: world.demand,
    state: world.state,
    failReason: world.failReason,
    quota: world.level.quota,
    timeLeft: Math.max(0, world.level.timeLimit - world.stats.elapsed),
  });
}
