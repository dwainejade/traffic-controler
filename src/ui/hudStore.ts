import { create } from "zustand";
import { PINNED_HOUR, hourOfDay } from "../art/daylight";
import type { FailReason, GameState, World } from "../sim/world";

/** Optional map overlays, toggled from the layers menu. */
export type LayerState = {
  /**
   * Moving traffic: the cars themselves, the queue overlay, and the simulation
   * that drives them.
   *
   * Unlike every other layer here this one is not presentational. Turning it off
   * unmounts the simulation rather than hiding its output, because the cost this
   * exists to remove is the physics, not the draw calls — a city steps thousands
   * of vehicles a frame, and skipping the meshes while still stepping them would
   * save almost nothing.
   *
   * The world keeps its state while off, so the traffic that comes back is the
   * traffic that left, paused mid-journey rather than restarted.
   */
  traffic: boolean;
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
  /** Fascia signs on the businesses the source map knew about. */
  shopSigns: boolean;
  /** Swap the fixed orthographic camera for a perspective one. */
  perspective: boolean;
  /** Blur what the player isn't looking at. */
  depthOfField: boolean;
  /** Let the lamps, lenses and indicators glow. */
  bloom: boolean;
  /** Autonomous low aerial flyover, edge to edge. Press C to jump to a new path. */
  cinematicCamera: boolean;
  /** First-person camera. WASD walks at eye height, F flies, Shift sprints. */
  walkCamera: boolean;
};

export type LayerName = keyof LayerState;

/** Menu order and wording live with the state so a new layer is one edit. */
export const LAYERS: { name: LayerName; label: string; hint: string }[] = [
  /*
   * First, because it is the only entry that changes what the machine is doing
   * rather than what the map looks like — and because somebody hunting for the
   * frame rate should find it before the fourth scenery toggle.
   */
  {
    name: "traffic",
    label: "Traffic",
    hint: "Run the simulation. Off stops the cars and the physics behind them — the cheapest way to look at a big map. Traffic resumes where it left off",
  },
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
    name: "shopSigns",
    label: "Shop signs",
    hint: "Fascia boards on the shops, in their own colours. Imported maps only — a hand-built level has no businesses on it",
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
  {
    name: "walkCamera",
    label: "Walk mode",
    hint: "Stand in the street. V toggles, click to look, WASD moves, F flies, Shift sprints. Esc frees the mouse for the HUD, Esc again leaves",
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
  /** Time multiplier. UI-owned. 0 pauses. */
  speed: number;
  observing: boolean;
  collisions: number;
  /** Vehicle-hours of delay, and the ceiling for this level if it has one. */
  delayHours: number;
  delayBudget: number | null;
  /** Mean seconds lost per car currently on the map. */
  networkDelay: number;
  /** Cars per second arriving, mirrored from the world so the sandbox can tune it. */
  demand: number;
  /**
   * How much of the network is being simulated, and over what radius. Dev
   * readout only — this is the one part of the region work with no other visible
   * evidence, since a well-behaved region looks exactly like simulating
   * everything.
   */
  simLanes: number;
  simLanesTotal: number;
  simRadius: number | null;
  /**
   * Map layers the player can turn on and off. UI-owned, like `speed`:
   * `publishHud` must never overwrite them.
   */
  layers: LayerState;
  /**
   * Metres ahead of the walker the lens focuses, adjustable from the layers
   * menu. UI-owned, like `speed`: `publishHud` must never overwrite it.
   */
  walkFocusDistance: number;
  /** Hours past midnight on the map's clock, for the HUD readout. */
  timeOfDay: number;
  state: GameState;
  failReason: FailReason;
  quota: number;
  timeLeft: number;
};

/** Default, and slider bounds, for `walkFocusDistance`, in metres. */
export const WALK_FOCUS_DISTANCE_DEFAULT = 25;
export const WALK_FOCUS_DISTANCE_MIN = 5;
export const WALK_FOCUS_DISTANCE_MAX = 80;

export const useHud = create<HudState>(() => ({
  delivered: 0,
  active: 0,
  elapsed: 0,
  meanWait: 0,
  speed: 1,
  observing: false,
  collisions: 0,
  delayHours: 0,
  delayBudget: null,
  networkDelay: 0,
  demand: 1,
  simLanes: 0,
  simLanesTotal: 0,
  simRadius: null,
  layers: {
    traffic: true,
    labels: true,
    streetSigns: true,
    streetLights: true,
    signals: true,
    daynight: true,
    parking: true,
    shopSigns: true,
    perspective: true,
    depthOfField: true,
    bloom: true,
    cinematicCamera: false,
    walkCamera: false,
  },
  walkFocusDistance: WALK_FOCUS_DISTANCE_DEFAULT,
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
  // Same for the walker: standing in the street only means anything with real
  // vanishing points. The two camera modes both own the camera transform
  // outright, so only one of them can be on at a time.
  if (name === "walkCamera" && next) {
    patch.perspective = true;
    patch.cinematicCamera = false;
  }
  if (name === "cinematicCamera" && next) patch.walkCamera = false;
  useHud.setState({ layers: { ...layers, ...patch } });
}

export function setWalkFocusDistance(distance: number): void {
  const clamped = Math.min(
    WALK_FOCUS_DISTANCE_MAX,
    Math.max(WALK_FOCUS_DISTANCE_MIN, distance),
  );
  useHud.setState({ walkFocusDistance: clamped });
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

/**
 * Mirror the simulation into React, a few times a second.
 *
 * Deliberately whole-map summary numbers only. This used to also publish a row
 * per junction — phases, splits, offset, and a queue length summed over every
 * inbound lane — because the HUD let you pick a junction and re-time it. That
 * walk was proportional to the size of the network rather than to anything on
 * screen, which on a city-sized map meant rebuilding an array of a couple of
 * thousand objects six times a second to render a list nobody was reading.
 */
export function publishHud(world: World): void {
  const previous = useHud.getState();
  const region = world.regionStats();

  useHud.setState({
    delivered: world.stats.delivered,
    active: world.stats.active,
    elapsed: world.stats.elapsed,
    meanWait: world.stats.meanWait,
    observing: world.observing,
    collisions: world.stats.collisions,
    delayHours: world.stats.delayHours,
    delayBudget: world.level.delayBudget ?? null,
    networkDelay: world.stats.networkDelay,
    demand: world.demand,
    simLanes: region.lanes,
    simLanesTotal: region.totalLanes,
    simRadius: world.regionRadius,
    timeOfDay: previous.layers.daynight
      ? hourOfDay(world.signalClock)
      : PINNED_HOUR,
    state: world.state,
    failReason: world.failReason,
    quota: world.level.quota,
    timeLeft: Math.max(0, world.level.timeLimit - world.stats.elapsed),
  });
}
