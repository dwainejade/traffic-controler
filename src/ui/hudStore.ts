import { create } from "zustand";
import { PINNED_HOUR, hourOfDay } from "../art/daylight";
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

/** Optional map overlays, toggled from the layers menu. */
export type LayerState = {
  /** Street names, drawn along the roads. */
  labels: boolean;
  /** Name signs on posts at the block corners. */
  streetSigns: boolean;
  /** Lamp columns along the streets, lit after dusk. */
  streetLights: boolean;
  /** Overhead signal heads on their mast arms. */
  signals: boolean;
  /** Move the sun with the clock. Off pins the map at noon. */
  daynight: boolean;
  /** Cars at the kerb. */
  parking: boolean;
  /** Swap the fixed orthographic camera for a perspective one. */
  perspective: boolean;
  /** Blur what the player isn't looking at. */
  depthOfField: boolean;
  /** Let the lamps, lenses and indicators glow. */
  bloom: boolean;
  /** Autonomous low aerial flyover, edge to edge. Press C to jump to a new path. */
  cinematicCamera: boolean;
};

export type LayerName = keyof LayerState;

/** Menu order and wording live with the state so a new layer is one edit. */
export const LAYERS: { name: LayerName; label: string; hint: string }[] = [
  { name: "labels", label: "Street names", hint: "Name every road on the map" },
  {
    name: "streetSigns",
    label: "Street signs",
    hint: "Name blades on posts at the corners. Lettered from the street-level camera",
  },
  {
    name: "signals",
    label: "Signal heads",
    hint: "Overhead heads showing each approach's colour",
  },
  {
    name: "streetLights",
    label: "Street lights",
    hint: "Lamp columns along every street. They come on with the clock",
  },
  {
    name: "daynight",
    label: "Day & night",
    hint: "Light, shadow and haze follow the clock. Off holds the map at midday",
  },
  {
    name: "parking",
    label: "Parked cars",
    hint: "Fill the kerbside bays. Off leaves the parking strips empty",
  },
  {
    name: "perspective",
    label: "Perspective camera",
    hint: "Street-level view, with real vanishing points. Off is the flat model view",
  },
  {
    name: "depthOfField",
    label: "Depth of field",
    hint: "Blur what you aren't looking at, like a tilt-shift model photo",
  },
  {
    name: "bloom",
    label: "Bloom",
    hint: "Signals, street lights and headlamps glow. Nothing else is bright enough to",
  },
  {
    name: "cinematicCamera",
    label: "Cinematic camera",
    hint: "Slow aerial flyover, edge to edge. Press C for a new path, or drag/scroll/WASD to cancel",
  },
];

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
  /** Vehicle-hours of delay, and the ceiling for this level if it has one. */
  delayHours: number;
  delayBudget: number | null;
  /** Mean seconds lost per car currently on the map. */
  networkDelay: number;
  /** Junction the camera should fly to. The nonce re-triggers a repeat click. */
  focus: { id: NodeId; nonce: number } | null;
  /** Cars per second arriving, mirrored from the world so the sandbox can tune it. */
  demand: number;
  /**
   * Map layers the player can turn on and off. UI-owned, like `selected` and
   * `speed`: `publishHud` must never overwrite them.
   */
  layers: LayerState;
  /** Hours past midnight on the map's clock, for the HUD readout. */
  timeOfDay: number;
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
  delayHours: 0,
  delayBudget: null,
  networkDelay: 0,
  focus: null,
  demand: 1,
  layers: {
    labels: true,
    streetSigns: true,
    streetLights: true,
    signals: true,
    daynight: true,
    parking: true,
    perspective: true,
    depthOfField: true,
    bloom: true,
    cinematicCamera: false,
  },
  timeOfDay: hourOfDay(0),
  state: "running",
  failReason: null,
  quota: 0,
  timeLeft: 0,
}));

export function toggleLayer(name: LayerName): void {
  const { layers } = useHud.getState();
  const next = !layers[name];
  const patch: Partial<LayerState> = { [name]: next };
  // Aerial motion needs real parallax — flat ortho would just look like the
  // map sliding around, not a camera moving through space.
  if (name === "cinematicCamera" && next) patch.perspective = true;
  useHud.setState({ layers: { ...layers, ...patch } });
}

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

let focusNonce = 0;

/** Send the camera to a junction — used by the congestion list. */
export function focusJunction(id: NodeId): void {
  useHud.setState({ selected: id, focus: { id, nonce: ++focusNonce } });
}

export function startLinking(seed: NodeId | null): void {
  useHud.setState({ linking: true, linkSelection: seed ? [seed] : [] });
}

export function cancelLinking(): void {
  useHud.setState({ linking: false, linkSelection: [] });
}

/** Nothing selected: the map is just a city again, and the editors go away. */
export function clearSelection(): void {
  useHud.setState({ selected: null });
}

/** Fastest time multiple the slider reaches. */
export const MAX_SPEED = 100;

/**
 * Slider position (0..1) to time multiple, and back.
 *
 * A linear 0-100 slider would spend nine tenths of its travel on speeds you
 * never want: the interesting range for watching traffic is 1x to about 10x,
 * and 100x is a single place you jump to. Squaring gives most of the track to
 * the low end while still reaching the top.
 */
export function speedForSlider(p: number): number {
  const raw = p * p * MAX_SPEED;
  if (raw < 0.05) return 0;
  return raw < 10 ? Math.round(raw * 10) / 10 : Math.round(raw);
}

export function sliderForSpeed(speed: number): number {
  return Math.sqrt(Math.max(0, Math.min(MAX_SPEED, speed)) / MAX_SPEED);
}

export function setSpeed(speed: number): void {
  useHud.setState({ speed });
}

/** Step the speed along the slider's own curve, for the bracket keys. */
export function nudgeSpeed(direction: 1 | -1): void {
  const current = useHud.getState().speed;
  const p = Math.max(
    0,
    Math.min(1, sliderForSpeed(current) + direction * 0.08),
  );
  useHud.setState({ speed: speedForSlider(p) });
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
    /*
     * Selection is the player's, and "nothing selected" is a real state — it is
     * how the city gets to be just a city, with the editors out of the way. So
     * this only ever preserves what the player chose; it never picks for them.
     */
    selected:
      previous.selected !== null &&
      junctions.some((j) => j.id === previous.selected)
        ? previous.selected
        : null,
    observing: world.observing,
    collisions: world.stats.collisions,
    delayHours: world.stats.delayHours,
    delayBudget: world.level.delayBudget ?? null,
    networkDelay: world.stats.networkDelay,
    demand: world.demand,
    timeOfDay: previous.layers.daynight
      ? hourOfDay(world.signalClock)
      : PINNED_HOUR,
    state: world.state,
    failReason: world.failReason,
    quota: world.level.quota,
    timeLeft: Math.max(0, world.level.timeLimit - world.stats.elapsed),
  });
}
