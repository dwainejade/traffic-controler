import { idmAccel, IDM } from "./idm";
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
import { TRUCK_ROUTE, type LevelDef, type NodeId } from "./types";
import {
  buildConflicts,
  buildPriority,
  illegalPairsInPhase,
  type ConflictMap,
  type Priority,
} from "./conflicts";
import { buildRouting, routeTo, type RoutingTables } from "./routing";
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

/** Speed cap through a turning connector, m/s. Tight turns are slow turns. */
const TURN_SPEED: Record<TurnKind, number> = {
  left: 6.0,
  right: 5.2,
  straight: IDM.v0,
};

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
 */
function criticalGapFor(kind: VehicleKind): number {
  const extra = VEHICLE[kind].length - VEHICLE.car.length;
  return CRITICAL_GAP + extra / TURN_SPEED.left;
}

/**
 * Shortest green a phase may be given. Below roughly this, the queue barely
 * starts moving before amber and the phase serves nobody.
 */
export const MIN_PHASE_GREEN = 4;

/** How far before a turn a driver starts indicating, in metres. */
const INDICATE_DISTANCE = 38;

/**
 * How fast a car crosses from the kerb to the lane, m/s.
 *
 * Slow, because the whole manoeuvre should be legible: a car that snaps into
 * the lane in a tenth of a second may as well have teleported, and the point of
 * modelling this at all is that the traffic behind can be seen to react to it.
 */
const LATERAL_SPEED = 1.5;

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
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) this.step(1 / 60);
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

    for (const j of this.junctions.values()) {
      stepJunction(j, this.signalClock, this.programOf(j));
    }

    this.spawn(dt);
    this.unpark(dt);
    this.runBuses(dt);
    this.drive(dt);
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
    for (const points of this.conflicts.byJunction.values()) {
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
      this.demand * this.rushMult(this.warming ? 0 : this.stats.elapsed) * dt;

    while (this.spawnAccum >= 1) {
      this.spawnAccum -= 1;

      // What arrives is decided before where it arrives from, because the kind
      // constrains the choice: a truck may only enter on a truck route, and
      // rolling the entry first would throw most of them away.
      const kind = this.pickKind();

      // Try a few random entries; drop the arrival if they're all backed up.
      let placed = false;
      for (let attempt = 0; attempt < 10 && !placed; attempt++) {
        const entry = this.pickWeighted(this.entries, (e) => e.weight);
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
    car.waited = 0;
    car.lateral = 0;
    car.lateralTarget = 0;
    car.manoeuvre = "none";
    car.slot = null;
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
  private retire(car: Car, how: "delivered" | "towed" | "parked"): void {
    if (!car.active) return;

    const lane = this.net.lanes[car.lane];
    const at = lane.cars.indexOf(car.id);
    if (at >= 0) lane.cars.splice(at, 1);

    car.active = false;
    this.free.push(car.id);
    this.stats.active--;

    if (how === "towed") {
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
    const { lanes } = this.net;

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

        car.v = Math.max(0, car.v + accel[car.id] * dt);
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

        // Ease across toward the lane, or across toward the kerb.
        if (car.lateral !== car.lateralTarget) {
          const step = LATERAL_SPEED * dt;
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
        }

        if (car.v < 0.15) {
          car.waited += dt;
          // Counted here rather than on delivery so cars still stuck in a jam
          // contribute to the score — they are the ones that matter most.
          this.stats.delayHours += dt / 3600;
        }
      }
    }

    this.advanceLanes();
    this.settleParking();
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
        const stopGap = toStop + IDM.s0;
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
            const stopGap = toBay + IDM.s0;
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
        } else if (this.yieldBlockedAt(nextId, junction, car.kind) !== null) {
          /*
           * Green, but the gap is not there yet. A driver does not sit behind
           * the line for this — they pull into the junction and wait alongside
           * the oncoming traffic, and turn when it stops or a gap opens. That
           * matters enormously: waiting at the line blocks the whole approach
           * behind them for the entire green, and on a one-lane street with a
           * steady opposing flow the left turn is never served at all, so the
           * queue grows without limit and the street gridlocks.
           *
           * One car at a time. The second waits at the line, exactly as it
           * would in life, because there is only room in the box for one.
           */
          stopped = this.net.lanes[nextId].cars.length > 0;
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
        const blockAt = this.yieldBlockedAt(lane.id, junction, car.kind, car.s);
        if (blockAt !== null) {
          const stopGap = blockAt - conflictRadius(car.kind) - car.s;
          if (stopGap < gap) {
            gap = stopGap;
            leaderV = 0;
          }
        }
      }
    }

    const spec = VEHICLE[car.kind];
    return idmAccel(car.v, gap, leaderV, v0, {
      a: spec.accel,
      b: spec.decel,
    });
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
    kind: VehicleKind,
    from = 0,
  ): number | null {
    const targets = this.priority.yieldTo.get(connectorId);
    if (targets === undefined) return null;

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
       */
      if (!blocked && target.feeder !== null) {
        const feeder = this.net.lanes[target.feeder];
        const leadId = feeder.cars[0];
        if (leadId !== undefined) {
          const lead = this.cars[leadId];
          const distance = feeder.length - lead.s + target.sAt;
          const approach = distance / Math.max(lead.v, IDM.v0 * 0.75);
          /*
           * The gap this vehicle needs, not the gap a car would need. Also add
           * the oncoming vehicle's own length: a bus bearing down on the point
           * is a longer obstacle to be clear of than a hatchback, and the extra
           * metres are extra seconds it will keep arriving for.
           */
          const needed =
            criticalGapFor(kind) +
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
    const own = VEHICLE[car.kind].v0;
    const lane = this.net.lanes[laneId];
    if (lane.kind !== "connector" || !lane.turn) return own;
    return Math.min(own, TURN_SPEED[lane.turn]);
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
    const lane = this.net.lanes[car.lane];

    // Mid-turn: keep indicating until the movement is complete.
    if (lane.kind === "connector") {
      return lane.turn === "straight" ? null : lane.turn;
    }

    const next = car.route[car.routeIdx + 1];
    if (next === undefined) return null;
    const turn = this.net.lanes[next].turn;
    if (turn === null || turn === "straight") return null;

    return lane.length - car.s <= INDICATE_DISTANCE ? turn : null;
  }
}
