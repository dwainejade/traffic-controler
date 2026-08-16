import { idmAccel, IDM, MAX_BRAKE, timeToCover, type DrivePower } from "./idm";
import { resolvePower, sampleDriver, type DriverProfile } from "./drivers";
import {
  CHANGE_COOLDOWN,
  LANE_CHANGES,
  mobilAccepts,
  type Follower,
} from "./laneChange";
import {
  createJunction,
  cycleOf,
  resetJunctionRuntime,
  stepJunction,
  uncoveredMovements,
  type Junction,
  type Program,
} from "./junction";
import {
  autoOffsets,
  createGroup,
  fitToTotal,
  resolveProgram,
  shiftSplit,
  type SignalGroup,
} from "./signals";
import {
  buildNetwork,
  sampleLane,
  type Lane,
  type LaneId,
  type Network,
  type TurnKind,
} from "./network";
import { LANE_WIDTH, TRUCK_ROUTE, type LevelDef, type NodeId } from "./types";
import {
  buildConflicts,
  buildPriority,
  illegalPairsInPhase,
  type ConflictMap,
  type ConflictPoint,
  type Priority,
} from "./conflicts";
import { buildRouting, routeTo, type RoutingTables } from "./routing";
import { buildRegionIndex, type RegionIndex } from "./region";
import { mulberry32 } from "../render/geometry";
import { VEHICLE_COLORS } from "../art/palette";
import { VEHICLE, conflictRadius, type VehicleKind } from "./vehicles";
import {
  bindParking,
  buildBusStops,
  buildParking,
  type BusStop,
  type ParkingLayout,
} from "./parking";

export {
  CAR_LENGTH,
  CAR_WIDTH,
  VEHICLE,
  type VehicleKind,
  type VehicleSpec,
} from "./vehicles";

/**
 * The simulation's fixed step, in seconds of simulated time.
 *
 * Lives here rather than in the renderer because `warmup` integrates too, and
 * for a long time it used a different figure — so a pre-warmed level settled
 * into a subtly different state from one the player watched fill up. Anything
 * with its own time constant (a driver's reaction lag, most of all) is sensitive
 * to that, so there is exactly one step size and both callers read it.
 */
export const FIXED_DT = 1 / 120;

/** Speed cap through a turning connector, m/s. Tight turns are slow turns. */
const TURN_SPEED: Record<TurnKind, number> = {
  left: 6.0,
  right: 5.2,
  straight: IDM.v0,
};

/**
 * How much of a driver's desired-speed deviation carries into the turn cap
 * above. Well under 1: the cap is set by the corner, not by the driver.
 */
const TURN_SPEED_TEMPERAMENT = 0.4;

/** How far ahead a car looks for a leader across lane boundaries. */
const LOOKAHEAD = 90;

/**
 * Seconds of clear oncoming traffic a permissive left turn needs before it will
 * commit. The traffic-engineering critical gap for a left across one opposing
 * lane is about 4.5s; a little more is used here because a car that misjudges
 * it in this model does not have a real driver's option of aborting halfway.
 */
const CRITICAL_GAP = 5.0;

/**
 * The critical gap above is a *car's*. A longer vehicle needs longer, because
 * the thing it has to get out of the way is its whole body: a 12-metre bus is
 * still lying across the conflict point a second and a half after a car would
 * have cleared it, and judging that turn on a car's gap is precisely how a bus
 * ends up broadside to the oncoming lane.
 *
 * Measured at the speed a vehicle actually takes a turn, not at free flow.
 *
 * Scaled by the driver, because gap acceptance is the most visibly personal
 * thing a driver does: two cars at the same junction facing the same oncoming
 * flow, one of which goes and one of which does not, is the single change that
 * stops a line of permissive lefts looking like it is being metered.
 */
function criticalGapFor(car: Car): number {
  const extra = VEHICLE[car.kind].length - VEHICLE.car.length;
  return (CRITICAL_GAP + extra / TURN_SPEED.left) * car.driver.gapScale;
}

/**
 * Shortest green a phase may be given. Below roughly this, the queue barely
 * starts moving before amber and the phase serves nobody.
 */
export const MIN_PHASE_GREEN = 4;

/** Furthest before a turn a driver starts indicating, in metres. */
const INDICATE_DISTANCE = 38;
/** Nearest, for a car that is stopped or crawling. */
const INDICATE_MIN = 12;
/** Between the two, a driver signals about this many seconds out. */
const INDICATE_SECONDS = 3;

/**
 * How fast a car crosses from the kerb to the lane, m/s.
 *
 * Slow, because the whole manoeuvre should be legible: a car that snaps into
 * the lane in a tenth of a second may as well have teleported, and the point of
 * modelling this at all is that the traffic behind can be seen to react to it.
 */
const LATERAL_SPEED = 1.5;

/**
 * How fast a car crosses between lanes, m/s.
 *
 * Faster than the parking manoeuvre above: one lane width in a little over a
 * second and a half, which is what a real lane change takes. Slower and the
 * driver looks like they are having second thoughts halfway across.
 */
const LANE_CHANGE_SPEED = 2.2;

/**
 * Clear road a car wants at each end of a lane change, in metres.
 *
 * A car still crossing between lanes as it reaches the junction is the one case
 * the conflict model cannot represent: movements are paired to lanes when the
 * network is built, so a car arriving in a lane whose connector it is not
 * routed through has no legal path across. Keeping the manoeuvre this far back
 * from the stop line means it is always finished before the question arises.
 */
const LANE_CHANGE_SETBACK = 20;

/**
 * Below this speed a driver is not shopping for a better lane, m/s.
 *
 * A stationary queue is exactly where the incentive term is loudest — the lane
 * beside you is always moving — and also exactly where changing is least
 * possible and least realistic. Without this the front of every red light
 * dissolves into cars shuffling sideways.
 */
const LANE_CHANGE_MIN_SPEED = 2;

/** Mean seconds between one parked car somewhere on the map deciding to leave. */
const UNPARK_INTERVAL = 9;

/**
 * Clear road a car needs behind a bay before it will pull out.
 *
 * Two car-lengths plus the standstill gap. Less than this and it emerges into
 * somebody's bonnet; the whole point of the check is that a car waits for a gap
 * exactly as a real one does.
 */
const PULLOUT_CLEARANCE = 2 * VEHICLE.car.length + IDM.s0;

/**
 * Share of arrivals that are going somewhere on the map rather than through it.
 *
 * Chosen against `UNPARK_INTERVAL` so the kerb stays roughly as full as it
 * started: at this level's demand the two rates come to about a ninth of a car
 * a second each. Unbalanced, the bays silently fill or empty over a long
 * session, and a kerb that is solid or deserted stops having gaps in it — which
 * is the only interesting thing about it.
 */
const PARKING_SHARE = 0.12;

/** How far before its bay a car starts easing over and slowing down. */
const PARK_APPROACH = 14;

/**
 * Share of arrivals that are trucks.
 *
 * This is the whole map's figure, but trucks can only enter on an arterial, so
 * the share *there* is several times higher — which is the right result and the
 * reason the number looks low. A New York avenue carries visible freight; the
 * street behind it carries none.
 */
const TRUCK_SHARE = 0.07;

/**
 * Seconds between buses on one corridor, jittered either side.
 *
 * Two minutes is a busy New York trunk route at peak — the B44 on Nostrand runs
 * about that. Much longer and a player watching one junction never sees a bus at
 * all, which would make the whole lane look like decoration.
 */
const BUS_HEADWAY = 120;

/** How far out a bus starts slowing for its stop, in metres. */
const STOP_APPROACH = 30;

export type Car = {
  id: number;
  active: boolean;
  kind: VehicleKind;
  lane: LaneId;
  /** Distance travelled along the current lane. */
  s: number;
  v: number;
  route: LaneId[];
  routeIdx: number;
  /** Index of the destination this car is routed to. */
  district: number;
  /** Index into the vehicle colour palette. Random, as in life. */
  colour: number;
  /** Who is driving: the one thing that differs between two identical cars. */
  driver: DriverProfile;
  /**
   * `driver` and the vehicle spec multiplied out, so the following model reads
   * four numbers instead of recomputing them for every car on every step.
   */
  power: DrivePower;
  /**
   * Current acceleration, m/s^2 — carried on the car rather than discarded each
   * step because the driver's response to it lags (see `drive`), and because it
   * is what the renderer needs to know whether the brake lights are on.
   */
  accel: number;
  /** Seconds spent stationary, for the wait-time score. */
  waited: number;
  /**
   * Metres to the right of the lane centreline. Zero for a car simply driving.
   *
   * The model tracks position along a lane and nothing across it, which is what
   * makes the whole lane graph work. This is the one deliberate exception: a car
   * pulling out of a bay is genuinely between the kerb and the lane, and drawing
   * it snapped to the lane centre while it does so makes the manoeuvre look like
   * a teleport. It moves nothing in the simulation — following distances, stop
   * lines and conflicts are all still measured along `s`.
   */
  lateral: number;
  /** Where `lateral` is easing to. */
  lateralTarget: number;
  /**
   * What the car is doing besides driving.
   *
   * `pullOut` — leaving a bay, still swinging into the lane.
   * `pullIn`  — committed to a bay and slowing onto it.
   */
  manoeuvre: "none" | "pullOut" | "pullIn";
  /** The bay this car is heading for, or came out of. */
  slot: number | null;
  /**
   * Which way this car last moved across the carriageway.
   *
   * `-1` toward the centreline, `+1` toward the kerb, `0` for a car that has not
   * changed lane. Read by the indicators — a lane change is signalled like any
   * other manoeuvre — and cleared once the car has finished sliding across.
   */
  changing: -1 | 0 | 1;
  /**
   * Seconds since this car last changed lane, saturating rather than growing
   * without bound. The cooldown it feeds is what stops two lanes of near-equal
   * incentive turning into one car swapping between them forever.
   */
  sinceChange: number;
  /**
   * Buses only: seconds left standing at a stop, and which stop that was.
   *
   * The served id is kept so a bus that has just pulled away does not
   * immediately see the stop it is still alongside and dwell there again.
   */
  dwellLeft: number;
  servedStop: number;
};

export type GameState = "running" | "won" | "lost";
export type FailReason = "crash" | "timeout" | null;

export type Crash = {
  x: number;
  z: number;
  /** The two cars involved, kept so the camera can frame them. */
  cars: [number, number];
  /** Simulation time at which it happened. */
  at: number;
};

export type WorldStats = {
  /** Cars that have completed their route. */
  delivered: number;
  /**
   * Cars created since construction (or reset) — every one of them, whether it
   * arrived at a map edge or pulled out of a kerbside bay. Unlike `delivered`
   * this is NOT zeroed by warmup, so at any instant the books must balance:
   * spawned = delivered-since-creation + retired + parked + active. The
   * validation harness asserts exactly that — a car that vanishes from the
   * ledger is how lane-handover bugs announce themselves.
   */
  spawned: number;
  /** Cars towed after a collision while warming or observing. Never warmup-zeroed. */
  retired: number;
  /**
   * Cars that ended their journey in a kerbside bay. A third way off the map
   * alongside delivery and towing, and the ledger above counts it as one.
   */
  parked: number;
  /**
   * Of the cars in `spawned`, how many came out of a bay rather than arriving
   * at a map edge. Informational — it is already inside `spawned`, and adding
   * it to the ledger would count those cars twice.
   */
  unparked: number;
  /** Cars currently on the map. */
  active: number;
  elapsed: number;
  /** Rolling mean of time spent stopped, seconds per delivered car. */
  meanWait: number;
  /** Collisions cleared while observing. Always 0 during a scored run. */
  collisions: number;
  /**
   * Vehicle-hours of delay accumulated across every car on the map, finished or
   * not. This is the measure a real traffic authority minimises, and the right
   * score for a city: it counts the cars still stuck in a jam, which "delivered"
   * conspicuously does not. Fixing the worst bottleneck moves it; polishing an
   * already-free-flowing junction does not.
   */
  delayHours: number;
  /** Mean seconds lost per car currently on the map. */
  networkDelay: number;
  /**
   * Lane changes made since construction. Diagnostic rather than scored: cars
   * oscillating between two lanes of near-equal incentive is the classic
   * failure of this model, and it shows up as neither a crash nor a delay —
   * only as this number being absurd.
   */
  laneChanges: number;
};

/** Linear interpolation between two rush-profile points. */
function interp(
  t: number,
  a: { t: number; mult: number },
  b: { t: number; mult: number },
): number {
  const span = b.t - a.t;
  if (span <= 0) return b.mult;
  const u = (t - a.t) / span;
  return a.mult + (b.mult - a.mult) * u;
}

const EMPTY_STATS = (): WorldStats => ({
  delivered: 0,
  spawned: 0,
  retired: 0,
  parked: 0,
  unparked: 0,
  active: 0,
  elapsed: 0,
  meanWait: 0,
  collisions: 0,
  delayHours: 0,
  networkDelay: 0,
  laneChanges: 0,
});

export class World {
  readonly level: LevelDef;
  readonly net: Network;
  readonly junctions = new Map<NodeId, Junction>();
  readonly groups = new Map<string, SignalGroup>();
  readonly cars: Car[] = [];

  /**
   * Master clock every signal program is derived from. Kept separate from
   * `stats.elapsed`, which `warmup()` zeroes — resetting the signal clock
   * mid-life would jump every junction's phase.
   */
  signalClock = 0;

  readonly conflicts: ConflictMap;
  /** Which crossings are illegal, and which are a give-way. */
  readonly priority: Priority;
  routing: RoutingTables;
  /**
   * One set of distance tables per class of vehicle, because they are not
   * allowed the same streets. Trucks get a network of arterials alone; cars get
   * everything. They share one `destinations` list in one order, so the world's
   * attraction weights index all of them identically.
   */
  readonly routingFor: Record<VehicleKind, RoutingTables>;
  /**
   * Every kerbside bay on the map, and who is in it. Owned by the world rather
   * than the renderer because the occupancy changes: cars pull out of these and
   * park back into them, and the renderer only ever reads the result.
   */
  readonly parking: ParkingLayout;
  /** Every bus stop on the map, and the stops on each bus lane. */
  readonly busStops: BusStop[];
  private stopsByLane = new Map<LaneId, BusStop[]>();

  stats: WorldStats = EMPTY_STATS();

  state: GameState = "running";
  failReason: FailReason = null;
  crash: Crash | null = null;

  /**
   * Free-running mode, entered after a level is cleared. The network keeps
   * simulating with no quota and no clock so the player can sit and watch the
   * flow they engineered. Collisions are logged and towed away rather than
   * ending anything — a sandbox that stops itself isn't much of a sandbox.
   */
  observing = false;

  /**
   * Cars per second entering the map across all approaches. Held below junction
   * capacity so that good signal timing visibly clears the queues — above
   * capacity every plan looks equally jammed and the player's choices stop
   * mattering. Arrivals that find a full approach are dropped, not queued.
   */
  demand = 0.55;

  private free: number[] = [];
  private spawnAccum = 0;
  private unparkAccum = 0;
  private waitTotal = 0;
  /** True while pre-filling the map, when the objective must not be judged. */
  private warming = false;
  private rand: () => number;
  /** Map-edge entry points, with the lanes available at each. */
  private entries: { node: NodeId; lanes: LaneId[]; weight: number }[] = [];
  /** Where each bus route enters, and how long until its next departure. */
  private busEntries: { lane: LaneId; node: NodeId; due: number }[] = [];
  /** Destination pick weights, aligned with `routing.destinations`. */
  private attractWeights: number[] = [];
  /** Cars spawned per entry node — the check that directional demand is real. */
  readonly spawnByEntry = new Map<NodeId, number>();

  /**
   * The part of the network currently being simulated, or null for all of it.
   *
   * See `region.ts` for why this exists. Null is the original behaviour in
   * full, and it is what every small map, the validator and the headless
   * harness all get: a region is only ever adopted when one is asked for *and*
   * it is smaller than the map, so nothing that fits on screen at once is ever
   * clipped.
   */
  private region: { x: number; z: number; radius: number } | null = null;
  private readonly regionIndex: RegionIndex;
  /** Whole-map fallbacks, so the null-region path allocates nothing per step. */
  private readonly allLanes: Lane[];
  private readonly allJunctions: Junction[] = [];
  private readonly allConflicts: ConflictPoint[][];

  /** What `step` actually iterates. Identical to the `all*` sets when unclipped. */
  private activeLanes: Lane[];
  private activeJunctions: Junction[];
  private activeConflicts: ConflictPoint[][];
  /** `1` where that lane is inside the region. Always all-ones when unclipped. */
  private laneActive: Uint8Array;
  /**
   * Where traffic enters the simulated area: the map edge when unclipped, and
   * the ring of lanes crossing the region boundary when not.
   */
  private frontier: { node: NodeId; lanes: LaneId[]; weight: number }[] = [];

  constructor(level: LevelDef) {
    this.level = level;
    this.net = buildNetwork(level);
    this.conflicts = buildConflicts(this.net);
    this.priority = buildPriority(this.net, this.conflicts);
    /*
     * Trucks are confined to the classes a city truck route is made of. On a
     * map whose arterials are parallel one-way avenues that never meet, this
     * comes out as "enter on the avenue, run down it, leave" — which is exactly
     * what a through truck does, and why it is called a through route.
     */
    const roadClass = new Map(level.roads.map((r) => [r.id, r.class]));
    const onTruckRoute = (lane: Lane) => {
      if (lane.roadId === null) return true; // connectors follow their road lanes
      const cls = roadClass.get(lane.roadId);
      /*
       * An unclassified road carries no trucks.
       *
       * Only the OSM levels classify their roads; the hand-authored ones are
       * geometry tests for the junction model, built and tuned around a 4.4m
       * car. Reading "no data" as "no restriction" put nine-metre trucks onto
       * `curve-test`'s deliberately tight radii, where they could not make the
       * turns and crashed within ninety seconds — the validator caught it, which
       * is exactly what it is for. Absent data is not permission.
       */
      return cls !== undefined && TRUCK_ROUTE.has(cls);
    };

    /*
     * Buses run the bus lanes and only the bus lanes. On this map both
     * corridors carry one the full width of the imported area, so a bus enters
     * on Rogers or Nostrand and leaves the same way — which is what those routes
     * do. Where a corridor did end, the bus would simply have no route, and no
     * bus would be put on it; that is better than inventing a merge the model
     * cannot represent.
     */
    const busOnly = (lane: Lane) => lane.access === "bus";
    const generalOnly = (lane: Lane) => lane.access === "all";

    this.routingFor = {
      // Cars and trucks are barred from the bus lane, which is the entire point
      // of painting one.
      car: buildRouting(this.net, generalOnly),
      truck: buildRouting(this.net, (l) => generalOnly(l) && onTruckRoute(l)),
      bus: buildRouting(this.net, busOnly),
    };
    this.routing = this.routingFor.car;

    /*
     * Stops first, then parking: the kerb beside a stop has to be kept clear
     * for the bus to reach it, so the parking layout is built knowing where
     * they are rather than being patched afterwards.
     */
    this.busStops = buildBusStops(level, this.net);
    for (const stop of this.busStops) {
      const list = this.stopsByLane.get(stop.laneId) ?? [];
      list.push(stop);
      this.stopsByLane.set(stop.laneId, list);
    }

    this.parking = buildParking(level, this.busStops);
    bindParking(level, this.net, this.parking);
    this.rand = mulberry32(level.seed ^ 0x9e3779b9);
    this.demand = level.demand;

    for (const node of level.nodes) {
      if (node.kind === "junction") {
        const junction = createJunction(this.net, node.id, this.priority);
        this.junctions.set(node.id, junction);

        if (import.meta.env?.DEV) {
          // Generated phases must never contain crossing movements.
          for (const phase of junction.phases) {
            const bad = illegalPairsInPhase(this.priority, phase.connectors);
            if (bad.length > 0) {
              console.error(
                `Phase "${phase.name}" at ${node.id} contains conflicting movements`,
                bad,
              );
            }
          }

          // And every movement must be served by *some* phase. A movement no
          // phase ever greens is the quiet failure: routes through it become
          // impossible and those cars queue forever with no visible cause.
          const stranded = uncoveredMovements(this.net, node.id, junction.phases);
          if (stranded.length > 0) {
            console.error(
              `Junction ${node.id} has ${stranded.length} movement(s) no phase ever serves`,
              stranded,
            );
          }
        }
      }
    }

    const byNode = new Map<NodeId, LaneId[]>();
    for (const id of this.net.spawnLanes) {
      const node = this.net.lanes[id].fromNode;
      if (node === null) continue;
      // General traffic must never be dropped onto a bus lane at the map edge.
      // The routing filter keeps it from *routing* through one; this is what
      // keeps it from starting in one.
      if (this.net.lanes[id].access !== "all") continue;
      const list = byNode.get(node) ?? [];
      list.push(id);
      byNode.set(node, list);
    }
    const weightOf = (id: NodeId, key: "spawnWeight" | "attractWeight") =>
      Math.max(0, level.nodes.find((n) => n.id === id)?.[key] ?? 1);
    this.entries = [...byNode].map(([node, lanes]) => ({
      node,
      lanes,
      weight: weightOf(node, "spawnWeight"),
    }));

    // Where a bus route enters the map: one per bus lane crossing the edge.
    // Staggered so the whole service does not depart in the same second.
    this.busEntries = this.net.spawnLanes
      .filter((id) => this.net.lanes[id].access === "bus")
      .map((id, i) => ({
        lane: id,
        node: this.net.lanes[id].fromNode!,
        due: (i * BUS_HEADWAY) / 3,
      }));
    this.attractWeights = this.routing.destinations.map((d) =>
      weightOf(d, "attractWeight"),
    );

    this.regionIndex = buildRegionIndex(level, this.net);
    this.allLanes = this.net.lanes;
    this.allJunctions = [...this.junctions.values()];
    this.allConflicts = [...this.conflicts.byJunction.values()];
    this.activeLanes = this.allLanes;
    this.activeJunctions = this.allJunctions;
    this.activeConflicts = this.allConflicts;
    this.laneActive = new Uint8Array(this.net.lanes.length).fill(1);
    this.frontier = this.entries;
    this.totalRoadLength = this.roadLengthOf(this.allLanes);
  }

  /**
   * Confine the simulation to a disc around a point — normally whatever the
   * camera is looking at.
   *
   * A request that would cover the whole map is not a region at all, and is
   * taken as a request to drop back to simulating everything. That is what
   * keeps the small maps behaving exactly as they always have without anything
   * having to know how big a map is: zoom out far enough on Dumbo and the disc
   * swallows it, and the clipping quietly switches itself off.
   *
   * Cheap to call every frame. The active sets are only rebuilt once the view
   * has actually moved a meaningful fraction of the region's own size, because
   * rebuilding them is a walk over every lane on the map and doing that per
   * frame would cost more than the clipping saves.
   */
  setRegion(x: number, z: number, radius: number): void {
    const mapRadius = this.level.half * Math.SQRT2;
    if (radius >= mapRadius) {
      this.clearRegion();
      return;
    }

    const current = this.region;
    if (current) {
      const moved = Math.hypot(x - current.x, z - current.z);
      const grew = Math.abs(radius - current.radius) / current.radius;
      if (moved < current.radius * 0.2 && grew < 0.1) return;
    }

    this.region = { x, z, radius };
    this.rebuildActive();
  }

  /** Simulate the whole network again. */
  clearRegion(): void {
    if (!this.region) return;
    this.region = null;
    this.activeLanes = this.allLanes;
    this.activeJunctions = this.allJunctions;
    this.activeConflicts = this.allConflicts;
    this.laneActive.fill(1);
    this.frontier = this.entries;
    this.demandShare = 1;
  }

  /** True while only part of the network is being simulated. */
  get clipped(): boolean {
    return this.region !== null;
  }

  /** Radius currently simulated, or null when that is the whole map. */
  get regionRadius(): number | null {
    return this.region?.radius ?? null;
  }

  /** How much of the network the current region covers, for the dev readout. */
  regionStats(): { lanes: number; junctions: number; totalLanes: number } {
    return {
      lanes: this.activeLanes.length,
      junctions: this.activeJunctions.length,
      totalLanes: this.allLanes.length,
    };
  }

  private rebuildActive(): void {
    const region = this.region;
    if (!region) return;

    const { centre, radius: laneRadius, junctionPos, incoming } = this.regionIndex;
    const { x, z, radius } = region;

    /*
     * How busy the traffic already is, measured before the region moves, so the
     * streets coming into it can be filled to match. See `seed`.
     */
    const density = this.laneDensity();
    const wasActive = this.laneActive.slice();

    this.laneActive.fill(0);
    const lanes: Lane[] = [];
    for (const lane of this.allLanes) {
      const dx = centre[lane.id * 2] - x;
      const dz = centre[lane.id * 2 + 1] - z;
      // Against the lane's bounding sphere, so a long lane reaching into the
      // region counts even when its midpoint is well outside it.
      if (Math.hypot(dx, dz) - laneRadius[lane.id] > radius) continue;
      this.laneActive[lane.id] = 1;
      lanes.push(lane);
    }
    this.activeLanes = lanes;

    this.activeJunctions = this.allJunctions.filter((j) => {
      const p = junctionPos.get(j.nodeId);
      if (!p) return false;
      return Math.hypot(p.x - x, p.z - z) <= radius;
    });

    this.activeConflicts = this.activeJunctions
      .map((j) => this.conflicts.byJunction.get(j.nodeId))
      .filter((points): points is ConflictPoint[] => points !== undefined);

    /*
     * The frontier: active road lanes that traffic can arrive on.
     *
     * Either the lane is a genuine map edge — those keep their level's spawn
     * weights, so a hand-tuned arterial still carries its share — or it is an
     * interior lane whose upstream neighbour has been clipped away, which is
     * where a street enters the simulated area from the part that isn't. Without
     * the second kind the region fills only from whichever map edges happen to
     * fall inside it, and a disc in the middle of a city has none at all.
     */
    const spawnable = new Set(this.net.spawnLanes);
    const byNode = new Map<NodeId, LaneId[]>();
    const edgeNodes = new Set<NodeId>();

    for (const lane of lanes) {
      if (lane.kind !== "road" || lane.access !== "all") continue;
      if (lane.fromNode === null) continue;

      const isEdge = spawnable.has(lane.id);
      if (!isEdge) {
        const feeders = incoming.get(lane.id);
        // No feeders at all means a dead end, which is not a way in.
        if (!feeders || feeders.length === 0) continue;
        if (feeders.every((id) => this.laneActive[id] === 1)) continue;
      }

      const list = byNode.get(lane.fromNode);
      if (list) list.push(lane.id);
      else byNode.set(lane.fromNode, [lane.id]);
      if (isEdge) edgeNodes.add(lane.fromNode);
    }

    const weightAt = (node: NodeId) =>
      edgeNodes.has(node)
        ? (this.entries.find((e) => e.node === node)?.weight ?? 1)
        : 1;

    this.frontier = [...byNode].map(([node, laneIds]) => ({
      node,
      lanes: laneIds,
      weight: weightAt(node),
    }));

    this.demandShare =
      this.totalRoadLength > 0
        ? this.roadLengthOf(lanes) / this.totalRoadLength
        : 1;

    this.seed(
      lanes.filter((l) => wasActive[l.id] === 0),
      density,
    );
  }

  /** Metres of general-traffic road lane in a set of lanes. */
  private roadLengthOf(lanes: readonly Lane[]): number {
    let total = 0;
    for (const lane of lanes) {
      if (lane.kind === "road" && lane.access === "all") total += lane.length;
    }
    return total;
  }

  /**
   * Share of the map's driveable lane length currently being simulated, which
   * is the factor arrivals have to be scaled by.
   *
   * `demand` is the whole map's arrival rate — cars per second across every
   * approach — and the frontier of a region is not every approach. Injecting the
   * whole city's traffic into a disc a fraction of its size floods it: at 25x on
   * a 720m region it produced 2,791 cars on 1,839 lanes, a solid jam that was
   * nothing but an artefact of how much map happened to be on screen. Scaling by
   * lane length keeps cars-per-metre — the thing you actually see — invariant to
   * the region's size, so zooming and speeding up change what is simulated
   * without changing how busy the streets look.
   */
  private demandShare = 1;

  /** Driveable lane length of the whole map, the denominator of `demandShare`. */
  private totalRoadLength = 0;

  /** Cars per metre of general-traffic road lane, over the simulated area. */
  private laneDensity(): number {
    let cars = 0;
    let length = 0;
    for (const lane of this.activeLanes) {
      if (lane.kind !== "road" || lane.access !== "all") continue;
      cars += lane.cars.length;
      length += lane.length;
    }
    return length > 0 ? cars / length : 0;
  }

  /**
   * Put traffic on streets that have just come into the simulated area.
   *
   * Without this, panning is a disaster to watch. Cars can only enter at the
   * frontier and have to drive inward from it, so the middle of the region —
   * exactly where the player is looking — is the *last* place to fill: at
   * typical speeds a car needs upwards of a minute of simulated time to cross
   * from the boundary to the centre. Panning to a new part of the city showed
   * empty roads that slowly came alive, which reads as the map being broken
   * rather than as the traffic being somewhere else.
   *
   * The density is measured from the traffic already running rather than picked,
   * so this matches whatever the map has settled at instead of asserting a
   * number of its own — and at a dead stop, or before the first warmup, the
   * measured density is zero and this does nothing at all.
   */
  private seed(lanes: Lane[], density: number): void {
    if (density <= 0) return;

    const tables = this.routingFor.car;
    // Room for a car and the gap it would keep, so seeding can never produce a
    // queue tighter than the car-following model would ever allow.
    const minGap = VEHICLE.car.length + IDM.s0 + 2;

    for (const lane of lanes) {
      if (lane.kind !== "road" || lane.access !== "all") continue;
      if (lane.cars.length > 0) continue;

      const expected = density * lane.length;
      let n = Math.floor(expected);
      // The fractional part as a probability, so low densities still scatter
      // cars about instead of rounding every lane down to none.
      if (this.rand() < expected - n) n++;
      n = Math.min(n, Math.floor(lane.length / minGap));
      if (n <= 0) continue;

      const gap = lane.length / n;
      for (let k = 0; k < n; k++) {
        // Front to back: `insertOnLane` wants descending `s`.
        const at = lane.length - (k + 0.5) * gap;
        const dest = this.pickWeighted(
          tables.destinations,
          (d, i) =>
            (tables.cost.get(d)?.[lane.id] ?? Infinity) === Infinity
              ? 0
              : this.attractWeights[i],
        );
        if (dest === null) continue;

        const route = routeTo(this.net, tables, lane.id, dest, this.rand);
        if (!route) continue;

        const car = this.create(route, tables.destinations.indexOf(dest), "car", at);
        // Mid-journey, not just arrived: a seeded car that thinks it has been
        // driving for zero seconds would drag the mean delay down every pan.
        car.v = VEHICLE.car.v0 * (0.6 + this.rand() * 0.4);
      }
    }
  }

  /**
   * Retire whatever has driven out of the simulated area.
   *
   * A car outside the region is not paused, it is gone: nothing steps its lane,
   * so leaving it in place would strand it mid-street forever and it would still
   * be there, stopped, when the player panned back. Counted as retired rather
   * than delivered — it did not finish its journey, and letting it score would
   * turn panning the camera into a way of banking cars.
   */
  private retireEscaped(): void {
    if (!this.region) return;
    for (const car of this.cars) {
      if (!car.active) continue;
      if (this.laneActive[car.lane] === 0) this.retire(car, "left");
    }
  }

  /** Demand multiplier at elapsed time t, from the level's rush profile. */
  rushMult(t: number): number {
    const rush = this.level.rush;
    if (!rush || rush.points.length === 0) return 1;
    const pts = rush.points;
    const last = pts[pts.length - 1];

    let at = t;
    if (rush.loop && last.t > 0) {
      at = ((t % last.t) + last.t) % last.t;
      // Between the wrap point and the first point, blend across the seam.
      if (at <= pts[0].t) return interp(at, { t: 0, mult: last.mult }, pts[0]);
    }

    if (at <= pts[0].t) return pts[0].mult;
    for (let i = 1; i < pts.length; i++) {
      if (at <= pts[i].t) return interp(at, pts[i - 1], pts[i]);
    }
    return last.mult;
  }

  /**
   * Run the network forward before the player takes over, so a level opens with
   * traffic already flowing rather than on an empty map. Scoring starts clean.
   */
  warmup(seconds: number): void {
    // The objective must not be evaluated while pre-filling the map, or the
    // level could be won or timed out before the player ever sees it.
    this.warming = true;
    const steps = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < steps; i++) this.step(FIXED_DT);
    this.warming = false;

    this.state = "running";
    this.failReason = null;
    this.crash = null;

    this.stats.delivered = 0;
    this.stats.elapsed = 0;
    this.stats.meanWait = 0;
    this.stats.collisions = 0;
    this.stats.delayHours = 0;
    this.stats.networkDelay = 0;
    this.waitTotal = 0;
    for (const car of this.cars) car.waited = 0;
  }

  /**
   * Drop the quota and the clock and keep the network running, so a cleared
   * level can be watched for as long as the player likes.
   */
  startObserving(): void {
    this.observing = true;
    this.state = "running";
    this.failReason = null;
    this.crash = null;
    this.stats.collisions = 0;
  }

  // ------------------------------------------------------------ programming

  /** The program a junction is actually running: its own, or its group's. */
  programOf(j: Junction): Program {
    return resolveProgram(j, j.groupId ? this.groups.get(j.groupId) : undefined);
  }

  groupOf(nodeId: NodeId): SignalGroup | undefined {
    const id = this.junctions.get(nodeId)?.groupId;
    return id ? this.groups.get(id) : undefined;
  }

  cycleFor(nodeId: NodeId): number {
    const j = this.junctions.get(nodeId);
    return j ? cycleOf(this.programOf(j), j.timing) : 0;
  }

  /**
   * Write a program back to wherever it came from. Editing a grouped junction
   * that has no override edits the group's parent — which is what makes a
   * parent program a parent rather than four copies.
   */
  private writeProgram(j: Junction, splits: number[]): void {
    const group = j.groupId ? this.groups.get(j.groupId) : undefined;
    if (!group) {
      j.program = { splits };
      return;
    }
    if (group.overrides.has(j.nodeId)) group.overrides.set(j.nodeId, splits);
    else group.parent = { splits };
  }

  /** Move green time between two adjacent phases, keeping the cycle fixed. */
  shiftSplit(nodeId: NodeId, index: number, seconds: number): void {
    const j = this.junctions.get(nodeId);
    if (!j) return;
    const splits = shiftSplit(
      this.programOf(j).splits,
      index,
      seconds,
      MIN_PHASE_GREEN,
    );
    this.writeProgram(j, splits);
  }

  /** Set one phase's green directly; the cycle grows or shrinks to match. */
  setSplit(nodeId: NodeId, index: number, seconds: number): void {
    const j = this.junctions.get(nodeId);
    if (!j) return;
    const splits = this.programOf(j).splits.slice();
    if (index < 0 || index >= splits.length) return;
    splits[index] = Math.max(MIN_PHASE_GREEN, seconds);
    this.writeProgram(j, splits);
  }

  /**
   * Rescale the whole cycle, preserving the shape of the splits. On a grouped
   * junction this necessarily moves the whole group — a shared cycle is the one
   * thing coordination cannot do without.
   */
  setCycle(nodeId: NodeId, cycle: number): void {
    const j = this.junctions.get(nodeId);
    if (!j) return;

    const clearance = j.phases.length * (j.timing.amber + j.timing.allRed);
    const green = Math.max(j.phases.length * MIN_PHASE_GREEN, cycle - clearance);

    const group = j.groupId ? this.groups.get(j.groupId) : undefined;
    if (group) {
      group.parent = { splits: fitToTotal(group.parent.splits, green) };
      for (const [id, splits] of group.overrides) {
        group.overrides.set(id, fitToTotal(splits, green));
      }
    } else {
      j.program = { splits: fitToTotal(j.program.splits, green) };
    }
  }

  setOffset(nodeId: NodeId, offset: number): void {
    const j = this.junctions.get(nodeId);
    if (!j) return;
    const cycle = this.cycleFor(nodeId) || 1;
    j.offset = ((offset % cycle) + cycle) % cycle;
    this.groupOf(nodeId)?.offsets.set(nodeId, j.offset);
  }

  // ----------------------------------------------------------------- groups

  /** Link junctions onto a shared cycle. The first member seeds the parent. */
  linkJunctions(members: NodeId[]): SignalGroup | null {
    const valid = members.filter((id) => this.junctions.has(id));
    if (valid.length < 2) return null;

    // Anyone already grouped leaves their old group first.
    for (const id of valid) this.unlinkJunction(id);

    const seed = this.junctions.get(valid[0])!;
    const group = createGroup(valid, seed.program);
    this.groups.set(group.id, group);

    for (const id of valid) {
      const j = this.junctions.get(id)!;
      j.groupId = group.id;
      group.offsets.set(id, j.offset);
    }
    return group;
  }

  unlinkJunction(nodeId: NodeId): void {
    const j = this.junctions.get(nodeId);
    if (!j || !j.groupId) return;
    const group = this.groups.get(j.groupId);
    if (!group) {
      j.groupId = null;
      return;
    }

    // Keep running exactly what it was running a moment ago.
    j.program = { splits: [...resolveProgram(j, group).splits] };
    group.members = group.members.filter((m) => m !== nodeId);
    group.offsets.delete(nodeId);
    group.overrides.delete(nodeId);
    j.groupId = null;

    // A group of one is just a junction.
    if (group.members.length < 2) {
      for (const id of group.members) {
        const member = this.junctions.get(id);
        if (!member) continue;
        member.program = { splits: [...resolveProgram(member, group).splits] };
        member.groupId = null;
      }
      this.groups.delete(group.id);
    }
  }

  /** Give a member its own splits, seeded from what it currently runs. */
  setOverride(nodeId: NodeId, on: boolean): void {
    const group = this.groupOf(nodeId);
    const j = this.junctions.get(nodeId);
    if (!group || !j) return;

    if (on) group.overrides.set(nodeId, [...resolveProgram(j, group).splits]);
    else group.overrides.delete(nodeId);
  }

  autoGreenWave(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const timing = this.junctions.get(group.members[0])?.timing;
    if (!timing) return;

    autoOffsets(this.level, this.net, group, timing);
    for (const [id, offset] of group.offsets) {
      const j = this.junctions.get(id);
      if (j) j.offset = offset;
    }
  }

  /** Fixed-timestep tick. Never call this with a variable dt. */
  step(dt: number): void {
    if (this.state !== "running") return;

    this.stats.elapsed += dt;
    this.signalClock += dt;

    for (const j of this.activeJunctions) {
      stepJunction(j, this.signalClock, this.programOf(j));
    }

    this.spawn(dt);
    this.unpark(dt);
    this.runBuses(dt);
    this.drive(dt);
    this.retireEscaped();
    this.checkCrashes();

    // Mean delay carried by the traffic currently out there. Unlike meanWait,
    // which only counts cars that finished, this rises the moment a jam forms.
    let waiting = 0;
    let count = 0;
    for (const car of this.cars) {
      if (!car.active) continue;
      waiting += car.waited;
      count++;
    }
    this.stats.networkDelay = count > 0 ? waiting / count : 0;

    // A sandbox level has no objective to win or lose — it just runs.
    if (this.state !== "running" || this.warming || this.observing || this.level.sandbox) return;

    const budget = this.level.delayBudget;
    if (budget !== undefined) {
      // Congestion objective: hold total delay under budget for the whole run.
      if (this.stats.delayHours > budget) {
        this.state = "lost";
        this.failReason = "timeout";
      } else if (this.stats.elapsed >= this.level.timeLimit) {
        this.state = "won";
      }
    } else if (this.stats.delivered >= this.level.quota) {
      this.state = "won";
    } else if (this.stats.elapsed >= this.level.timeLimit) {
      this.state = "lost";
      this.failReason = "timeout";
    }
  }

  /**
   * Two cars occupying the same conflict point is a crash, and a crash ends the
   * run. Because cars never run reds, every crash traces back to a signal state
   * the player created — either conflicting greens, or a phase cut short that
   * left somebody stranded in the box.
   */
  private checkCrashes(): void {
    for (const points of this.activeConflicts) {
      for (const p of points) {
        const laneA = this.net.lanes[p.a];
        if (laneA.cars.length === 0) continue;
        const laneB = this.net.lanes[p.b];
        if (laneB.cars.length === 0) continue;

        for (const idA of laneA.cars) {
          if (Math.abs(this.cars[idA].s - p.sA) > conflictRadius(this.cars[idA].kind))
            continue;

          for (const idB of laneB.cars) {
            if (Math.abs(this.cars[idB].s - p.sB) > conflictRadius(this.cars[idB].kind))
              continue;

            if (this.observing || this.warming || this.level.sandbox) {
              /*
               * Log it, clear the wreck, and carry on.
               *
               * Observing wants this because a sandbox that stops itself is not
               * much of a sandbox. Warmup needs it for a subtler reason: a crash
               * sets `state` to lost, after which every step returns immediately
               * — so a single collision would silently halt the pre-fill and
               * hand the player a half-populated map with no indication why.
               */
              this.stats.collisions++;
              this.retire(this.cars[idA], "towed");
              this.retire(this.cars[idB], "towed");
              return;
            }

            this.state = "lost";
            this.failReason = "crash";
            this.crash = {
              x: p.x,
              z: p.z,
              cars: [idA, idB],
              at: this.stats.elapsed,
            };
            return;
          }
        }
      }
    }
  }

  reset(): void {
    this.observing = false;
    this.state = "running";
    this.failReason = null;
    this.crash = null;
    this.stats = EMPTY_STATS();
    this.waitTotal = 0;
    this.spawnAccum = 0;
    this.free.length = 0;
    this.cars.length = 0;
    this.spawnByEntry.clear();
    for (const lane of this.net.lanes) lane.cars.length = 0;

    // Programs, offsets and groups survive a retry — losing the plan you just
    // wrote every time you restart would make the game unplayable.
    this.signalClock = 0;
    for (const j of this.junctions.values()) resetJunctionRuntime(j);

    this.rand = mulberry32(this.level.seed ^ 0x9e3779b9);
  }

  // ---------------------------------------------------------------- spawning

  private spawn(dt: number): void {
    // Rush multiplies the base rate, so the sandbox demand slider still works.
    // Warmup fills the map at the profile's opening level.
    this.spawnAccum +=
      this.demand *
      this.demandShare *
      this.rushMult(this.warming ? 0 : this.stats.elapsed) *
      dt;

    while (this.spawnAccum >= 1) {
      this.spawnAccum -= 1;

      // What arrives is decided before where it arrives from, because the kind
      // constrains the choice: a truck may only enter on a truck route, and
      // rolling the entry first would throw most of them away.
      const kind = this.pickKind();

      // Try a few random entries; drop the arrival if they're all backed up.
      let placed = false;
      for (let attempt = 0; attempt < 10 && !placed; attempt++) {
        const entry = this.pickWeighted(this.frontier, (e) => e.weight);
        if (!entry) break;

        // Send it somewhere other than where it came from, weighted by how
        // strongly each destination attracts traffic.
        const tables = this.routingFor[kind];
        const dest = this.pickWeighted(
          tables.destinations,
          (d, i) => (d === entry.node ? 0 : this.attractWeights[i]),
        );
        if (dest === null) continue;
        const cost = tables.cost.get(dest);
        if (!cost) continue;

        /*
         * Choose the destination first, then the lane that actually serves it.
         * Picking the lane first drops cars into the left-turn pocket regardless
         * of where they are going, and the router then has to send them the long
         * way round to make the forced left work out.
         */
        let best: LaneId[] = [];
        let bestCost = Infinity;
        for (const laneId of entry.lanes) {
          const c = cost[laneId];
          if (c < bestCost) {
            bestCost = c;
            best = [laneId];
          } else if (c === bestCost) {
            best.push(laneId);
          }
        }
        if (bestCost === Infinity) continue;

        const laneId = best[Math.floor(this.rand() * best.length)];
        const lane = this.net.lanes[laneId];

        // Entry must be clear, or vehicles would materialise on top of a queue.
        // A bus needs three times a car's room to appear in.
        const rear = lane.cars[lane.cars.length - 1];
        if (rear !== undefined && this.cars[rear].s < VEHICLE[kind].length + IDM.s0 + 3)
          continue;

        const route = routeTo(this.net, tables, laneId, dest, this.rand);
        if (!route) continue;

        const car = this.create(route, tables.destinations.indexOf(dest), kind);

        /*
         * Some of this traffic lives here. Without it every car on the map is
         * passing through, the kerb only ever empties, and the street reads as a
         * bypass rather than as somewhere with addresses on it.
         *
         * Trucks and buses are exempt: neither parks at a residential kerb, and
         * neither would fit in the bay if it tried.
         */
        if (kind === "car" && this.rand() < PARKING_SHARE) {
          car.slot = this.pickSlotAlong(route);
        }

        this.spawnByEntry.set(entry.node, (this.spawnByEntry.get(entry.node) ?? 0) + 1);
        placed = true;
      }
    }
  }

  // ----------------------------------------------------------------- buses

  /**
   * Run the service.
   *
   * Buses are not drawn from the demand pool. A scheduled service does not
   * arrive by Poisson process — it arrives on a headway, and the difference is
   * visible: random buses clump into pairs and leave five-minute holes, which is
   * the one thing about a bus route everybody notices and complains about. A
   * timer with a little jitter reads as a service; a random draw reads as a
   * mistake.
   *
   * Each corridor entrance is served independently, so a two-avenue couplet runs
   * two routes rather than one.
   */
  private runBuses(dt: number): void {
    if (this.busEntries.length === 0) return;

    for (const entry of this.busEntries) {
      entry.due -= dt;
      if (entry.due > 0) continue;
      entry.due = BUS_HEADWAY * (0.8 + this.rand() * 0.4);

      const lane = this.net.lanes[entry.lane];
      // Never materialise on top of the bus already at the stop line.
      const rear = lane.cars[lane.cars.length - 1];
      if (rear !== undefined && this.cars[rear].s < VEHICLE.bus.length + IDM.s0 + 4) {
        // Try again shortly rather than skipping the whole headway.
        entry.due = BUS_HEADWAY * 0.15;
        continue;
      }

      /*
       * Weight destinations by whether this corridor actually reaches them.
       *
       * The shared destination list covers every map edge, and a bus lane
       * reaches exactly one of them — the far end of its own avenue. Drawing
       * from the full list uniformly means seventeen departures in eighteen
       * pick somewhere unreachable, and since the headway has already been
       * reset by then, each of those silently cancels a bus. The service was
       * running at about a twentieth of its timetable.
       */
      const tables = this.routingFor.bus;
      const reach = tables.cost;
      const dest = this.pickWeighted(tables.destinations, (d, i) => {
        if (d === entry.node) return 0;
        const cost = reach.get(d);
        if (!cost || cost[entry.lane] === Infinity) return 0;
        return this.attractWeights[i];
      });
      if (dest === null) continue;
      const route = routeTo(this.net, tables, entry.lane, dest, this.rand);
      if (!route) continue;

      this.create(route, tables.destinations.indexOf(dest), "bus");
    }
  }

  // --------------------------------------------------------------- parking

  /**
   * Somebody, somewhere, decides to leave.
   *
   * A parked car is not simulated, so unparking is not a state transition — it
   * is a *creation*, and it is the only way a vehicle enters the map other than
   * at a map edge. That is what makes it worth having: the traffic on a
   * residential street stops being purely through-traffic that arrived from
   * somewhere else, and starts having somewhere it came from.
   */
  private unpark(dt: number): void {
    this.unparkAccum += dt / UNPARK_INTERVAL;

    while (this.unparkAccum >= 1) {
      this.unparkAccum -= 1;

      const { slots } = this.parking;
      if (slots.length === 0) return;

      // A few tries, then give up until the next tick — every candidate can
      // legitimately be blocked when the street is busy, which is the point.
      for (let attempt = 0; attempt < 8; attempt++) {
        const slot = slots[Math.floor(this.rand() * slots.length)];
        if (slot.occupant === null || slot.laneId < 0) continue;

        const lane = this.net.lanes[slot.laneId];
        // Never emerge on top of the junction box at the far end.
        if (slot.laneS > lane.length - VEHICLE.car.length) continue;

        /*
         * The gap has to be clear *behind* the bay as well as in front of it: a
         * car pulling out is a new obstacle appearing mid-queue, and without
         * this the vehicle already there would find itself inside one.
         */
        let clear = true;
        for (const id of lane.cars) {
          if (Math.abs(this.cars[id].s - slot.laneS) < PULLOUT_CLEARANCE) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;

        const dest = this.pickWeighted(
          this.routing.destinations,
          (_, i) => this.attractWeights[i],
        );
        if (dest === null) continue;
        const route = routeTo(this.net, this.routing, slot.laneId, dest, this.rand);
        if (!route) continue;

        const car = this.create(
          route,
          this.routing.destinations.indexOf(dest),
          "car",
          slot.laneS,
        );
        // It starts where the bay is and swings out to the lane centre.
        car.v = 0;
        car.lateral = slot.laneLateral;
        car.lateralTarget = 0;
        car.manoeuvre = "pullOut";
        car.slot = slot.id;
        car.colour = slot.colour;

        slot.occupant = null;
        this.parking.revision++;
        this.stats.unparked++;
        return;
      }
    }
  }

  /**
   * Pick a bay for a car to aim at, somewhere along the route it is already
   * taking.
   *
   * Deliberately not "route to a chosen bay": that would need a second routing
   * table keyed on lanes rather than map edges, and it would also be the wrong
   * behaviour. A driver looking for kerbside parking takes the space they pass,
   * not the one they decided on before setting off.
   */
  private pickSlotAlong(route: LaneId[]): number | null {
    const candidates: number[] = [];

    // Skip the first lane: a car should get somewhere before it parks, and a
    // bay on the entry lane means it appears and immediately stops.
    for (let k = 1; k < route.length; k++) {
      const lane = this.net.lanes[route[k]];
      if (lane.kind !== "road" || lane.roadId === null) continue;
      for (const id of this.parking.byRoad.get(lane.roadId) ?? []) {
        const slot = this.parking.slots[id];
        if (slot.occupant === null && slot.laneId === lane.id) candidates.push(id);
      }
    }

    if (candidates.length === 0) return null;
    return candidates[Math.floor(this.rand() * candidates.length)];
  }

  /**
   * Finish the manoeuvre for anybody who has reached their bay.
   *
   * Run after integration rather than during it, so a car is judged on where it
   * ended the step and not where it was partway through one.
   */
  private settleParking(): void {
    for (const lane of this.net.lanes) {
      for (let i = lane.cars.length - 1; i >= 0; i--) {
        const car = this.cars[lane.cars[i]];
        if (car.manoeuvre !== "pullIn" || car.slot === null) continue;

        const slot = this.parking.slots[car.slot];
        /*
         * Arrival is "stopped, next to the bay" rather than "past the bay".
         * A car easing to a halt approaches its target asymptotically and may
         * never quite cross it, so a position test alone can leave somebody
         * parked half a metre short in the middle of the road indefinitely.
         */
        if (slot.laneS - car.s > 0.6 || car.v > 0.6) continue;

        // Arrived. Snap onto the bay and hand the car over to the scenery.
        slot.occupant = -1;
        slot.colour = car.colour;
        this.parking.revision++;
        car.manoeuvre = "none";
        car.slot = null;
        car.lateral = 0;
        car.lateralTarget = 0;
        this.retire(car, "parked");
      }
    }
  }

  /** Weighted random pick; null when every weight is zero. */
  private pickWeighted<T>(items: T[], weightOf: (item: T, index: number) => number): T | null {
    let total = 0;
    for (let i = 0; i < items.length; i++) total += weightOf(items[i], i);
    if (total <= 0) return null;
    let roll = this.rand() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weightOf(items[i], i);
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /**
   * Which kind of vehicle the next arrival is.
   *
   * Buses are deliberately absent: a scheduled service does not arrive by
   * Poisson draw, it arrives on a headway, and it is spawned on its own timer.
   */
  private pickKind(): VehicleKind {
    return this.rand() < TRUCK_SHARE ? "truck" : "car";
  }

  private create(
    route: LaneId[],
    district: number,
    kind: VehicleKind = "car",
    at = 0,
  ): Car {
    const laneId = route[0];

    const id = this.free.pop();
    const car: Car =
      id !== undefined
        ? this.cars[id]
        : ({ id: this.cars.length } as Car);

    car.active = true;
    car.kind = kind;
    car.lane = laneId;
    car.s = at;
    car.v = VEHICLE[kind].v0 * 0.8;
    car.route = route;
    car.routeIdx = 0;
    car.district = district;
    car.colour = this.pickColour();
    // Every field must be assigned here, not just on first construction: `car`
    // above may be a recycled object off the free list, still carrying the
    // previous occupant's driver.
    car.driver = sampleDriver(this.rand, kind);
    car.power = resolvePower(kind, car.driver);
    car.accel = 0;
    car.waited = 0;
    car.lateral = 0;
    car.lateralTarget = 0;
    car.manoeuvre = "none";
    car.slot = null;
    car.changing = 0;
    car.sinceChange = CHANGE_COOLDOWN;
    car.dwellLeft = 0;
    car.servedStop = -1;

    if (id === undefined) this.cars.push(car);

    this.insertOnLane(this.net.lanes[laneId], car);
    this.stats.active++;
    this.stats.spawned++;
    return car;
  }

  /**
   * Take a car off the map.
   *
   * `delivered` completed its route, `towed` was removed after a collision and
   * must not count toward the score, `parked` reached a kerbside bay — which is
   * a perfectly good end to a journey, and is counted separately only so the
   * ledger keeps balancing.
   */
  private retire(
    car: Car,
    how: "delivered" | "towed" | "parked" | "left",
  ): void {
    if (!car.active) return;

    const lane = this.net.lanes[car.lane];
    const at = lane.cars.indexOf(car.id);
    if (at >= 0) lane.cars.splice(at, 1);

    car.active = false;
    this.free.push(car.id);
    this.stats.active--;

    // Neither finished a journey, so neither counts towards delivered or the
    // mean wait — they only have to stay in `spawned`'s accounting.
    if (how === "towed" || how === "left") {
      this.stats.retired++;
      return;
    }

    if (how === "parked") this.stats.parked++;
    else this.stats.delivered++;

    // A journey that ended in a bay took just as long as one that left the map,
    // and the time its driver spent stopped counts the same.
    this.waitTotal += car.waited;
    const finished = this.stats.delivered + this.stats.parked;
    this.stats.meanWait = finished > 0 ? this.waitTotal / finished : 0;
  }

  /**
   * Put a car onto a lane, keeping `lane.cars` ordered front-most first.
   *
   * Spawned cars enter at s=0 and belong on the end, but a car pulling out of a
   * bay appears in the middle of a moving queue. Appending it there would put
   * the list out of order, and the car-following pass reads index i-1 as "the
   * car in front" — so a mis-ordered list has cars braking for vehicles behind
   * them and driving through the ones ahead.
   */
  private insertOnLane(lane: Network["lanes"][number], car: Car): void {
    let at = lane.cars.length;
    while (at > 0 && this.cars[lane.cars[at - 1]].s < car.s) at--;
    lane.cars.splice(at, 0, car.id);
  }

  // ----------------------------------------------------------------- driving

  private drive(dt: number): void {
    // Only the simulated part of the network: on a clipped map this is the
    // single biggest saving in the step, because it is the one loop that runs
    // over every lane whether or not anything is in it.
    const lanes = this.activeLanes;

    // Accelerations are computed for every car before any car moves, so the
    // result doesn't depend on lane iteration order.
    const accel = new Float64Array(this.cars.length);

    for (const lane of lanes) {
      for (let i = 0; i < lane.cars.length; i++) {
        const car = this.cars[lane.cars[i]];
        const ahead = i > 0 ? this.cars[lane.cars[i - 1]] : null;
        accel[car.id] = this.accelFor(car, ahead);
      }
    }

    // Integrate, then hand cars over to the next lane in their route.
    for (const lane of lanes) {
      for (let i = lane.cars.length - 1; i >= 0; i--) {
        const car = this.cars[lane.cars[i]];

        /*
         * A bus standing at a stop. It does not accelerate, it does not move,
         * and the traffic behind it queues through the ordinary car-following
         * model — which on a bus lane means the next bus, and nobody else. That
         * is the entire benefit of the lane, made visible.
         */
        if (car.dwellLeft > 0) {
          car.dwellLeft -= dt;
          car.v = 0;
          car.waited += dt;
          this.stats.delayHours += dt / 3600;
          continue;
        }

        /*
         * A driver does not arrive at the acceleration the model asks for
         * instantly — they see the change, decide, and move a foot, and the
         * whole thing takes a fraction of a second. Modelled as a first-order
         * lag on the acceleration rather than as a true delayed observation:
         * one float per car instead of a ring buffer of past states, and stable
         * at any step size, where a real delay is not.
         *
         * That lag is what makes traffic waves. With a perfect controller a
         * platoon absorbs a disturbance; with a late one it amplifies it
         * backwards down the queue, which is the stop-and-go every driver knows
         * and no version of this model has previously produced.
         *
         * The exception is not optional. An emergency stop is reflex, not
         * deliberation, and easing gently towards full braking over a third of a
         * second is precisely long enough to hit the car in front — so a target
         * at the braking ceiling is applied on the spot.
         */
        const target = accel[car.id];
        if (target <= MAX_BRAKE + 0.5) {
          car.accel = target;
        } else {
          car.accel += (target - car.accel) * Math.min(1, dt / car.driver.reaction);
        }

        car.v = Math.max(0, car.v + car.accel * dt);
        car.s += car.v * dt;

        // Pulled up at a stop it has not served: open the doors.
        if (car.kind === "bus" && car.v < 0.6) {
          for (const stop of this.stopsByLane.get(car.lane) ?? []) {
            if (stop.id === car.servedStop) continue;
            if (Math.abs(stop.laneS - car.s) > 1.2) continue;
            car.dwellLeft = stop.dwell;
            car.servedStop = stop.id;
            break;
          }
        }

        car.sinceChange = Math.min(CHANGE_COOLDOWN, car.sinceChange + dt);

        // Ease across toward the lane, or across toward the kerb.
        if (car.lateral !== car.lateralTarget) {
          /*
           * A lane change crosses faster than a parking manoeuvre does. Pulling
           * out of a bay is deliberately slow so the manoeuvre is legible and
           * the traffic behind can be seen reacting to it; a driver changing
           * lane at speed is across in a second and a half, and dawdling makes
           * them look like they are having second thoughts.
           */
          const step =
            (car.changing !== 0 ? LANE_CHANGE_SPEED : LATERAL_SPEED) * dt;
          const remaining = car.lateralTarget - car.lateral;
          car.lateral =
            Math.abs(remaining) <= step
              ? car.lateralTarget
              : car.lateral + Math.sign(remaining) * step;
          // Straight again, so the car is simply driving.
          if (car.manoeuvre === "pullOut" && car.lateral === 0) {
            car.manoeuvre = "none";
            car.slot = null;
          }
          // Arrived wherever it was heading, so the indicator goes out.
          if (car.lateral === car.lateralTarget) car.changing = 0;
        }

        if (car.v < 0.15) {
          car.waited += dt;
          // Counted here rather than on delivery so cars still stuck in a jam
          // contribute to the score — they are the ones that matter most.
          this.stats.delayHours += dt / 3600;
        }
      }
    }

    this.changeLanes();
    this.advanceLanes();
    this.settleParking();
  }

  /**
   * Offer every eligible car the lane beside it.
   *
   * Runs after the integration pass and before `advanceLanes`, so a car is
   * looked at once, at a settled position, and cannot both change lane and hand
   * over to the next lane of its route in the same step.
   *
   * The change is instantaneous in the model and animated in the render: the car
   * is spliced straight into the target lane and given a `lateral` offset back
   * toward the one it left, which the easing above then closes. This is the same
   * device the parking model uses, and it is what keeps the whole feature clear
   * of the 1-D invariant the rest of the simulation depends on — a car is on
   * exactly one lane, and `lane.cars` stays ordered front-most first.
   *
   * The cost, which is real: for the second or so of the animation the car is
   * followed as though it were already fully across, so the driver it left
   * behind stops seeing it a little early. That is why the safety test below is
   * applied to *both* lanes rather than only the one being entered.
   */
  private changeLanes(): void {
    if (!LANE_CHANGES) return;
    for (const lane of this.net.lanes) {
      if (lane.kind !== "road") continue;
      if (lane.left === null && lane.right === null) continue;

      // Backwards, because a change splices the car out of `lane.cars` and a
      // forward walk would then skip its neighbour.
      for (let i = lane.cars.length - 1; i >= 0; i--) {
        const car = this.cars[lane.cars[i]];
        if (!this.mayChange(car, lane)) continue;

        const ahead = i > 0 ? this.cars[lane.cars[i - 1]] : null;
        const behind =
          i + 1 < lane.cars.length ? this.cars[lane.cars[i + 1]] : null;

        for (const side of [-1, 1] as const) {
          const targetId = side < 0 ? lane.left : lane.right;
          if (targetId === null) continue;
          const target = this.net.lanes[targetId];
          if (!this.mayEnter(car, lane, target)) continue;
          if (!this.changeAccepted(car, lane, target, ahead, behind, side)) continue;

          // Last, because it is the expensive test: a lane is only worth having
          // if the rest of the journey still exists from it.
          const tail = this.routeFrom(car, target);
          if (tail === null) continue;

          this.commitChange(car, lane, target, side, tail);
          break;
        }
      }
    }
  }

  /** Whether this car is in a position to be considering a lane change at all. */
  private mayChange(car: Car, lane: Lane): boolean {
    /*
     * Buses never change lane. Their stops are bound to a particular lane when
     * the network is built (`stopsByLane`), so a bus that moved across would
     * sail past its own stop and never register having served it — and a bus
     * route that skips stops is a worse bug than a bus stuck behind a car.
     */
    if (car.kind === "bus") return false;
    /*
     * Nor does a car with a bay booked. The bay is on the kerbside lane and the
     * approach test asks whether the car is *on* that lane; move inward and it
     * drives past its own destination.
     */
    if (car.slot !== null) return false;
    // Committed to a bay, or still swinging out of one. `lateral` belongs to
    // that manoeuvre and the two must never both be writing it.
    if (car.manoeuvre !== "none") return false;
    // Still sliding across from the last one.
    if (car.changing !== 0) return false;
    if (car.sinceChange < CHANGE_COOLDOWN) return false;
    // A bus at a stop is not going anywhere, and neither is a stationary queue.
    if (car.dwellLeft > 0) return false;
    if (car.v < LANE_CHANGE_MIN_SPEED) return false;

    /*
     * Not on the approach to the stop line. A car still crossing between lanes
     * as it enters the junction box is the one case the conflict model cannot
     * represent — movements are paired to lanes at build time, and a car that
     * arrives in a lane its connector does not leave from has no legal path.
     */
    if (lane.stopS >= 0 && car.s > lane.stopS - LANE_CHANGE_SETBACK) return false;
    // Nor so close to the end of the link that the slide would outlast it.
    return lane.length - car.s >= LANE_CHANGE_SETBACK;
  }

  /** Whether this car is allowed in that lane at all, before any gap question. */
  private mayEnter(car: Car, from: Lane, target: Lane): boolean {
    /*
     * Never across the general/bus boundary, in either direction.
     *
     * Outward is the obvious half: the bus lane is somebody's neighbour, and
     * general traffic may not use it however empty it looks — that restriction
     * is the entire reason it is worth simulating. Inward matters just as much
     * though, because connectors out of a bus lane are built assuming the
     * corridor continues, so a bus that wandered into general traffic would be
     * standing in a lane with no movement onto the rest of its own route.
     */
    if (target.access !== from.access) return false;
    // Room to physically be there.
    return target.length > VEHICLE[car.kind].length;
  }

  /**
   * The car in `target` immediately ahead of, and immediately behind, arc
   * length `s`. `lane.cars` is ordered front-most first, so the first entry
   * with a smaller `s` is the follower and the one before it is the leader.
   */
  private neighboursAt(target: Lane, s: number): [Car | null, Car | null] {
    let i = 0;
    while (i < target.cars.length && this.cars[target.cars[i]].s > s) i++;
    return [
      i > 0 ? this.cars[target.cars[i - 1]] : null,
      i < target.cars.length ? this.cars[target.cars[i]] : null,
    ];
  }

  /** Clear distance from `follower`'s nose at `s` to `leader`'s rear bumper. */
  private gapTo(s: number, leader: Car | null): { gap: number; leaderV: number } {
    if (leader === null) return { gap: Infinity, leaderV: 0 };
    return {
      gap: leader.s - s - VEHICLE[leader.kind].length,
      leaderV: leader.v,
    };
  }

  /** One party to the decision, as the IDM wants it. */
  private follower(car: Car, s: number, leader: Car | null, v0: number): Follower {
    const { gap, leaderV } = this.gapTo(s, leader);
    return { v: car.v, gap, leaderV, v0, power: car.power };
  }

  /**
   * Whether MOBIL accepts this change.
   *
   * Everything here is the plain car-following term — deliberately not
   * `accelFor`, which folds in signals, bus stops and parking bays. Those are
   * properties of where the car is going, not of which lane it is in, and
   * including them would have a driver change lane to get away from a red light
   * that is red in both.
   */
  private changeAccepted(
    car: Car,
    from: Lane,
    target: Lane,
    ahead: Car | null,
    behind: Car | null,
    side: -1 | 1,
  ): boolean {
    // Sibling lanes have matching vertices but not matching arc length — an
    // offset curve runs long on the outside of a bend — so map proportionally
    // rather than carrying `s` across unchanged.
    const sTarget = from.length > 0 ? (car.s / from.length) * target.length : car.s;
    const [newLeader, newFollower] = this.neighboursAt(target, sTarget);

    const v0 = this.speedOf(car, car.lane);

    return mobilAccepts(
      {
        selfBefore: this.follower(car, car.s, ahead, v0),
        selfAfter: this.follower(car, sTarget, newLeader, v0),

        targetFollowerBefore:
          newFollower &&
          this.follower(newFollower, newFollower.s, newLeader, this.speedOf(newFollower, target.id)),
        targetFollowerAfter:
          newFollower &&
          this.follower(newFollower, newFollower.s, car, this.speedOf(newFollower, target.id)),

        sourceFollowerBefore:
          behind &&
          this.follower(behind, behind.s, car, this.speedOf(behind, from.id)),
        sourceFollowerAfter:
          behind &&
          this.follower(behind, behind.s, ahead, this.speedOf(behind, from.id)),
      },
      car.driver.politeness,
      side,
    );
  }

  /**
   * The rest of this car's journey, starting from `target` — or `null` if there
   * isn't one.
   *
   * This is the check that stops lane changing from quietly breaking routing.
   * Movements are bound to lanes when the network is built: a left turn leaves
   * only from the lane nearest the centreline, a right only from the lane
   * nearest the kerb. A car's route was found from the lane it spawned in, so
   * the moment it moves across, every connector named further down that route
   * may be one its new lane does not feed. Re-deriving the tail is the honest
   * answer, and a change that has no tail is simply refused.
   *
   * Cheap enough despite the BFS walk behind it, because the cooldown means a
   * car asks this at most once every few seconds.
   */
  private routeFrom(car: Car, target: Lane): LaneId[] | null {
    const dest = this.routing.destinations[car.district];
    if (dest === undefined) return null;
    return routeTo(this.net, this.routingFor[car.kind], target.id, dest, this.rand);
  }

  /**
   * Move the car across. Instantaneous in the model; the `lateral` offset it is
   * given is what the renderer spends the next second and a half closing.
   */
  private commitChange(
    car: Car,
    from: Lane,
    target: Lane,
    side: -1 | 1,
    tail: LaneId[],
  ): void {
    const at = from.cars.indexOf(car.id);
    if (at >= 0) from.cars.splice(at, 1);

    car.s = from.length > 0 ? (car.s / from.length) * target.length : car.s;
    car.lane = target.id;
    // Everything from here on was found from the lane the car has just left, so
    // it is replaced wholesale with the tail found from the new one. `routeIdx`
    // does not move: it still points at the link the car is on, which is now
    // the first entry of the tail.
    car.route.length = car.routeIdx;
    for (const id of tail) car.route.push(id);
    this.insertOnLane(target, car);

    /*
     * Drawn where it still is, and eased to where it now officially is. Sitting
     * one lane width back toward the lane it left, on the side it came from:
     * moving right means it was to the left, which is a negative offset.
     */
    car.lateral = -side * LANE_WIDTH;
    car.lateralTarget = 0;
    car.changing = side;
    car.sinceChange = 0;
    this.stats.laneChanges++;
  }

  private accelFor(car: Car, ahead: Car | null): number {
    const lane = this.net.lanes[car.lane];

    // Ease off before a turn rather than braking on entry to it.
    let v0 = this.speedOf(car, car.lane);
    const nextId = car.route[car.routeIdx + 1];
    if (nextId !== undefined && lane.length - car.s < 18) {
      v0 = Math.min(v0, this.speedOf(car, nextId));
    }

    let gap = Infinity;
    let leaderV = 0;

    /*
     * The gap is measured to the *leader's* rear bumper, so the length
     * subtracted is the leader's, not this car's. With one vehicle size the two
     * were the same number and the distinction never showed; behind a bus it is
     * eight metres of difference, and getting it backwards would have cars
     * driving into the back of one.
     */
    if (ahead) {
      gap = ahead.s - car.s - VEHICLE[ahead.kind].length;
      leaderV = ahead.v;
    } else {
      // Front of its queue: look across lane boundaries so queues propagate
      // back through connectors instead of stopping at the junction mouth.
      let dist = lane.length - car.s;
      for (let k = car.routeIdx + 1; k < car.route.length && dist < LOOKAHEAD; k++) {
        const nl = this.net.lanes[car.route[k]];
        const rearId = nl.cars[nl.cars.length - 1];
        if (rearId !== undefined) {
          const rear = this.cars[rearId];
          gap = dist + rear.s - VEHICLE[rear.kind].length;
          leaderV = rear.v;
          break;
        }
        dist += nl.length;
      }
    }

    /*
     * A bus stop the bus has not served yet is a stationary leader standing on
     * it, which is the same device the bay below and the red light further down
     * both use. Aimed past by the standstill gap for the same reason: IDM stops
     * short of a leader, and a bus that halts two metres before its own stop
     * never arrives at it.
     */
    if (car.kind === "bus" && car.dwellLeft <= 0) {
      for (const stop of this.stopsByLane.get(car.lane) ?? []) {
        if (stop.id === car.servedStop) continue;
        const toStop = stop.laneS - car.s;
        if (toStop < 0 || toStop > STOP_APPROACH) continue;
        // This driver's standstill gap, not the fleet average: IDM comes to rest
        // with `s0` still in hand, so a stop line aimed past by anything else
        // leaves the bus short of its own stop and it never registers arrival.
        const stopGap = toStop + car.driver.s0;
        if (stopGap < gap) {
          gap = stopGap;
          leaderV = 0;
        }
      }
    }

    /*
     * A bay the car is aiming for is a stationary leader sitting in it — the
     * same trick the red light below uses, and for the same reason: "slow to a
     * stop at this distance" is already solved, and a second deceleration model
     * would only be a second thing to get wrong.
     *
     * It also gets the traffic behind for free. A car easing to a halt at the
     * kerb is a leader like any other, so the queue that briefly forms behind
     * somebody parking is the ordinary car-following model doing its job.
     */
    if (car.slot !== null && car.manoeuvre !== "pullOut") {
      const slot = this.parking.slots[car.slot];
      if (car.lane === slot.laneId) {
        const toBay = slot.laneS - car.s;
        if (toBay < PARK_APPROACH) {
          // Somebody else took it while this car was on its way. Drive on; the
          // route to the map edge is intact and was never abandoned.
          if (slot.occupant !== null) {
            car.slot = null;
          } else {
            if (car.manoeuvre !== "pullIn") {
              car.manoeuvre = "pullIn";
              car.lateralTarget = slot.laneLateral;
            }
            /*
             * Aim past the bay by the standstill gap. IDM comes to rest with
             * `s0` still in hand — it is modelling the space you leave behind
             * the car in front — so a leader placed *on* the bay stops the car
             * two metres short of it, where it sits in the running lane
             * forever, blocks the street, and never registers as having
             * arrived. There is nothing in front to leave room for here.
             */
            const stopGap = toBay + car.driver.s0;
            if (stopGap < gap) {
              gap = stopGap;
              leaderV = 0;
            }
          }
        }
      }
    }

    // A red light is a stationary leader parked on the stop line. Once a car is
    // past the line it is committed, which is what makes a short phase change
    // able to strand somebody in the box.
    if (lane.stopS >= 0 && car.s <= lane.stopS) {
      const junction = lane.junction ? this.junctions.get(lane.junction) : undefined;
      /*
       * Two separate reasons to hold at the line, and they read the same to the
       * car following behind: the movement is not green, or it is green but the
       * driver has to give way. A permissive left turn on a green ball is the
       * second case — it may go, but only into a gap.
       */
      let stopped = false;
      if (junction !== undefined && nextId !== undefined) {
        if (!junction.green.has(nextId)) {
          stopped = true;
        } else if (this.yieldBlockedAt(nextId, junction, car) !== null) {
          /*
           * Green, but the gap is not there yet. A driver does not sit behind
           * the line for this — they pull into the junction and wait alongside
           * the oncoming traffic, and turn when it stops or a gap opens. That
           * matters enormously: waiting at the line blocks the whole approach
           * behind them for the entire green, and on a one-lane street with a
           * steady opposing flow the left turn is never served at all, so the
           * queue grows without limit and the street gridlocks.
           *
           * How many wait in there is a question of room, not a rule.
           *
           * This used to be "one, always": anybody was blocked whenever the
           * connector held a single car, however far along it that car had got.
           * Measured on the crossroads, that was 73% of all the time a left
           * turner spent held at the line, and it capped the movement at 0.80
           * cars per green — with 157 of 360 greens serving nobody at all.
           *
           * A real junction stores whatever fits. So the test is whether there
           * is space behind the last vehicle in the box, which lets the next car
           * move up as the one ahead advances and be ready to follow it through
           * the same gap, rather than starting from the line once it has gone.
           * The car that moves up is not thereby committed to crossing: the
           * mid-turn give-way check below still holds it short of the point
           * where the paths actually meet.
           */
          const box = this.net.lanes[nextId];
          const rearId = box.cars[box.cars.length - 1];
          if (rearId !== undefined) {
            const rear = this.cars[rearId];
            stopped = rear.s < VEHICLE[car.kind].length + car.driver.s0;
          }
        }
      }

      if (stopped) {
        const stopGap = lane.stopS - car.s;
        if (stopGap < gap) {
          gap = stopGap;
          leaderV = 0;
        }
      }
    }

    /*
     * A give-way movement keeps looking after it has committed.
     *
     * Deciding only at the stop line is not enough: the gap a driver accepted
     * can close while the turn is being made, and with nothing watching for
     * that, left turners drove into the side of oncoming traffic — which is
     * exactly what the validator caught. So a car partway through the turn
     * carries a virtual stationary leader at the point where the two paths
     * meet, and holds short of it rather than crossing.
     *
     * This also gives the behaviour that makes a permissive left work at all:
     * when the phase ends, the oncoming movement is no longer green, the block
     * lifts, and whoever is waiting in the box completes the turn on the amber.
     */
    if (lane.kind === "connector" && lane.from !== null) {
      const owner = this.net.lanes[lane.from].junction;
      const junction = owner !== null ? this.junctions.get(owner) : undefined;
      if (junction) {
        const blockAt = this.yieldBlockedAt(lane.id, junction, car, car.s);
        if (blockAt !== null) {
          const stopGap = blockAt - conflictRadius(car.kind) - car.s;
          if (stopGap < gap) {
            gap = stopGap;
            leaderV = 0;
          }
        }
      }
    }

    return idmAccel(car.v, gap, leaderV, v0, car.power);
  }

  /**
   * Whether a give-way movement may go.
   *
   * A permissive left turn has a green ball, not a green arrow: it is allowed
   * into the junction, but only once the traffic coming the other way leaves a
   * gap big enough to turn across. This is the rule that makes a two-phase
   * signal work at all, and it is also where a lot of real delay comes from —
   * on a single-lane approach the through traffic queued behind a waiting left
   * turner is stuck too, which is precisely why turn bays exist.
   *
   * Movements with nothing to give way to return true immediately, so the
   * ordinary case costs one failed map lookup.
   */
  private yieldBlockedAt(
    connectorId: LaneId,
    junction: Junction,
    car: Car,
    from = 0,
  ): number | null {
    const targets = this.priority.yieldTo.get(connectorId);
    if (targets === undefined) return null;

    const kind = car.kind;

    let earliest: number | null = null;

    for (const target of targets) {
      /*
       * A point already behind the car is settled — it is across, and the only
       * thing left to do is finish. Without this a car that has just cleared a
       * crossing keeps treating it as a blocker, brakes for a point it is
       * standing on, and stops in the middle of the conflict rather than
       * driving out of it. That was the remaining source of collisions.
       */
      if (target.sSelf <= from + conflictRadius(kind)) continue;

      // Traffic that is itself held at a red is no reason to wait.
      if (!junction.green.has(target.connector)) continue;

      let blocked = false;

      // Anyone already in the box on that movement and not yet past the point
      // where the two paths meet.
      const crossing = this.net.lanes[target.connector];
      for (const carId of crossing.cars) {
        // Not yet past the meeting point, measured to its own rear bumper: a bus
        // is clear of the point long after its nose has crossed it.
        if (this.cars[carId].s <= target.sAt + VEHICLE[this.cars[carId].kind].length) {
          blocked = true;
          break;
        }
      }

      /*
       * Anyone approaching who would arrive before the turn is complete. Only
       * the front car on the feeding lane can matter — the rest are behind it —
       * so this stays O(1) however long the queue is.
       *
       * Arrival is estimated at close to free-flow speed rather than at the
       * car's current speed. A car stopped at the head of its own queue is
       * doing 0 and looks like it will never arrive, when in fact it is about
       * to launch; taking its present speed at face value is what put cars into
       * the side of oncoming traffic.
       *
       * That used to be handled by flooring its speed at three quarters of free
       * flow, which fixed the launching car by breaking the stationary one:
       * measured, two thirds of the time a left turn was refused for want of a
       * gap, the traffic it was yielding to was *stopped*. `timeToCover`
       * integrates the launch instead, which is right in both cases.
       */
      if (!blocked && target.feeder !== null) {
        const feeder = this.net.lanes[target.feeder];
        const leadId = feeder.cars[0];
        if (leadId !== undefined) {
          const lead = this.cars[leadId];
          const distance = feeder.length - lead.s + target.sAt;
          const approach = timeToCover(
            distance,
            lead.v,
            lead.power.a,
            this.speedOf(lead, lead.lane),
          );
          /*
           * The gap this vehicle needs, not the gap a car would need. Also add
           * the oncoming vehicle's own length: a bus bearing down on the point
           * is a longer obstacle to be clear of than a hatchback, and the extra
           * metres are extra seconds it will keep arriving for.
           */
          const needed =
            criticalGapFor(car) +
            (VEHICLE[lead.kind].length - VEHICLE.car.length) / IDM.v0;
          if (approach < needed) blocked = true;
        }
      }

      if (!blocked) continue;
      if (earliest === null || target.sSelf < earliest) earliest = target.sSelf;
    }

    return earliest;
  }

  /**
   * Desired speed for this vehicle on this lane: the lower of what it wants and
   * what the movement allows. A truck's ceiling is below the limit everywhere,
   * and a tight turn's ceiling is below a truck's — whichever binds, binds.
   */
  private speedOf(car: Car, laneId: LaneId): number {
    const own = VEHICLE[car.kind].v0 * car.driver.v0Scale;
    const lane = this.net.lanes[laneId];
    if (lane.kind !== "connector" || !lane.turn) return own;

    /*
     * The turn cap moves with the driver too, but by less than their desired
     * speed does. A hurried driver does take a corner faster than a cautious
     * one; what they cannot do is take it 8% faster than the geometry allows,
     * because the limit there is the radius of the connector and not their
     * patience.
     */
    const turnScale = 1 + (car.driver.v0Scale - 1) * TURN_SPEED_TEMPERAMENT;
    return Math.min(own, TURN_SPEED[lane.turn] * turnScale);
  }

  private advanceLanes(): void {
    for (const lane of this.net.lanes) {
      // Only the front car can leave, and it always leaves from index 0.
      while (lane.cars.length > 0) {
        const car = this.cars[lane.cars[0]];
        if (car.s <= lane.length) break;

        lane.cars.shift();

        if (car.routeIdx >= car.route.length - 1) {
          this.retire(car, "delivered");
          continue;
        }

        car.s -= lane.length;
        car.routeIdx++;
        car.lane = car.route[car.routeIdx];
        this.net.lanes[car.lane].cars.push(car.id);
      }
    }
  }

  /** Current world-space pose of a car, for rendering. */
  pose(car: Car, out: { x: number; z: number; angle: number }): void {
    sampleLane(this.net.lanes[car.lane], car.s, out);
    if (car.lateral === 0) return;

    /*
     * Offset to the driver's right. The heading is atan2(dx, dz), so the
     * forward vector is (sin, cos) and its right-hand normal is (-cos, sin) —
     * the same convention `rightOf` uses in the network and the road markings
     * use in the renderer.
     */
    const fx = Math.sin(out.angle);
    const fz = Math.cos(out.angle);
    out.x += -fz * car.lateral;
    out.z += fx * car.lateral;

    /*
     * Angle the body into the swing. A car crabbing sideways with its nose
     * dead ahead is the tell that this is an offset and not a manoeuvre; the
     * yaw is small because the lateral speed is small next to the forward one.
     */
    if (car.manoeuvre !== "none") {
      const drift = car.lateralTarget - car.lateral;
      out.angle -= Math.max(-0.5, Math.min(0.5, drift * 0.16));
    }
  }

  private pickColour(): number {
    const total = VEHICLE_COLORS.reduce((a, c) => a + c.weight, 0);
    let roll = this.rand() * total;
    for (let i = 0; i < VEHICLE_COLORS.length; i++) {
      roll -= VEHICLE_COLORS[i].weight;
      if (roll <= 0) return i;
    }
    return 0;
  }

  /**
   * Which way a car is about to turn, or is turning now — `null` when going
   * straight on or when the turn is still too far off to be signalling.
   *
   * Distance matters: indicating from the far end of a link would be useless as
   * a cue. Real drivers signal on the approach, which is also the point at which
   * the information is worth anything to somebody watching.
   */
  turnIntent(car: Car): TurnKind | null {
    /*
     * Mid-lane-change, which takes precedence over any turn further on: it is
     * happening now, it is the thing the traffic around this car needs to know
     * about, and a driver only has the two indicators. `changing` is -1 toward
     * the centreline, which is the driver's left.
     */
    if (car.changing !== 0) return car.changing < 0 ? "left" : "right";

    const lane = this.net.lanes[car.lane];
    const next = car.route[car.routeIdx + 1];

    // Mid-turn: keep indicating until the movement is complete.
    if (lane.kind === "connector") {
      if (lane.turn !== null && lane.turn !== "straight") return lane.turn;
      /*
       * Going straight through this connector, but the route turns immediately
       * out of the far side of it. A junction laid out as two connectors back to
       * back is one manoeuvre to anybody watching, and going dark across the
       * middle of it reads as the driver changing their mind.
       */
      if (next !== undefined && this.net.lanes[next].kind === "connector") {
        const onward = this.net.lanes[next].turn;
        if (onward !== null && onward !== "straight") return onward;
      }
      return null;
    }

    if (next === undefined) return null;
    const turn = this.net.lanes[next].turn;
    if (turn === null || turn === "straight") return null;

    /*
     * Distance matters, and so does speed. A fixed distance means a car crawling
     * at the back of a queue indicates from the far end of the block — long
     * before the information is any use, and long enough that half the queue is
     * blinking at once. Roughly three seconds of travel is what a real driver
     * gives, with a floor so a stationary car at the head of the queue is still
     * showing where it is about to go.
     */
    const at = Math.max(INDICATE_MIN, Math.min(INDICATE_DISTANCE, car.v * INDICATE_SECONDS));
    return lane.length - car.s <= at ? turn : null;
  }
}
