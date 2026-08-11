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
  type LaneId,
  type Network,
  type TurnKind,
} from "./network";
import type { LevelDef, NodeId } from "./types";
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

export const CAR_LENGTH = 4.4;
export const CAR_WIDTH = 1.9;

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
 * Shortest green a phase may be given. Below roughly this, the queue barely
 * starts moving before amber and the phase serves nobody.
 */
export const MIN_PHASE_GREEN = 4;

/** How far before a turn a driver starts indicating, in metres. */
const INDICATE_DISTANCE = 38;

export type Car = {
  id: number;
  active: boolean;
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

/**
 * Half-extent used when testing whether a car occupies a conflict point. A car
 * blocks the point when its centre is within roughly half its own length plus
 * half the crossing car's width.
 */
const CONFLICT_RADIUS = (CAR_LENGTH + CAR_WIDTH) / 2;

export type WorldStats = {
  /** Cars that have completed their route. */
  delivered: number;
  /**
   * Cars created since construction (or reset). Unlike `delivered` this is NOT
   * zeroed by warmup, so at any instant the books must balance:
   * spawned = delivered-since-creation + retired + active. The validation
   * harness asserts exactly that — a car that vanishes from the ledger is how
   * lane-handover bugs announce themselves.
   */
  spawned: number;
  /** Cars towed after a collision while warming or observing. Never warmup-zeroed. */
  retired: number;
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
  readonly routing: RoutingTables;

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
  private waitTotal = 0;
  /** True while pre-filling the map, when the objective must not be judged. */
  private warming = false;
  private rand: () => number;
  /** Map-edge entry points, with the lanes available at each. */
  private entries: { node: NodeId; lanes: LaneId[]; weight: number }[] = [];
  /** Destination pick weights, aligned with `routing.destinations`. */
  private attractWeights: number[] = [];
  /** Cars spawned per entry node — the check that directional demand is real. */
  readonly spawnByEntry = new Map<NodeId, number>();

  constructor(level: LevelDef) {
    this.level = level;
    this.net = buildNetwork(level);
    this.conflicts = buildConflicts(this.net);
    this.priority = buildPriority(this.net, this.conflicts);
    this.routing = buildRouting(this.net);
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
          if (Math.abs(this.cars[idA].s - p.sA) > CONFLICT_RADIUS) continue;

          for (const idB of laneB.cars) {
            if (Math.abs(this.cars[idB].s - p.sB) > CONFLICT_RADIUS) continue;

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
              this.retire(this.cars[idA], false);
              this.retire(this.cars[idB], false);
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

      // Try a few random entries; drop the arrival if they're all backed up.
      let placed = false;
      for (let attempt = 0; attempt < 10 && !placed; attempt++) {
        const entry = this.pickWeighted(this.entries, (e) => e.weight);
        if (!entry) break;

        // Send it somewhere other than where it came from, weighted by how
        // strongly each destination attracts traffic.
        const dest = this.pickWeighted(
          this.routing.destinations,
          (d, i) => (d === entry.node ? 0 : this.attractWeights[i]),
        );
        if (dest === null) continue;
        const cost = this.routing.cost.get(dest);
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

        // Entry must be clear, or cars would materialise on top of a queue.
        const rear = lane.cars[lane.cars.length - 1];
        if (rear !== undefined && this.cars[rear].s < CAR_LENGTH + IDM.s0 + 3) continue;

        const route = routeTo(this.net, this.routing, laneId, dest, this.rand);
        if (!route) continue;

        this.create(route, this.routing.destinations.indexOf(dest));
        this.spawnByEntry.set(entry.node, (this.spawnByEntry.get(entry.node) ?? 0) + 1);
        placed = true;
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

  private create(route: LaneId[], district: number): void {
    const laneId = route[0];

    const id = this.free.pop();
    const car: Car =
      id !== undefined
        ? this.cars[id]
        : ({ id: this.cars.length } as Car);

    car.active = true;
    car.lane = laneId;
    car.s = 0;
    car.v = IDM.v0 * 0.8;
    car.route = route;
    car.routeIdx = 0;
    car.district = district;
    car.colour = this.pickColour();
    car.waited = 0;

    if (id === undefined) this.cars.push(car);

    this.net.lanes[laneId].cars.push(car.id);
    this.stats.active++;
    this.stats.spawned++;
  }

  /**
   * Take a car off the map. `delivered` distinguishes completing a route from
   * being removed after a collision, which must not count toward the score.
   */
  private retire(car: Car, delivered: boolean): void {
    if (!car.active) return;

    const lane = this.net.lanes[car.lane];
    const at = lane.cars.indexOf(car.id);
    if (at >= 0) lane.cars.splice(at, 1);

    car.active = false;
    this.free.push(car.id);
    this.stats.active--;

    if (delivered) {
      this.stats.delivered++;
      this.waitTotal += car.waited;
      this.stats.meanWait = this.waitTotal / this.stats.delivered;
    } else {
      this.stats.retired++;
    }
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
        car.v = Math.max(0, car.v + accel[car.id] * dt);
        car.s += car.v * dt;
        if (car.v < 0.15) {
          car.waited += dt;
          // Counted here rather than on delivery so cars still stuck in a jam
          // contribute to the score — they are the ones that matter most.
          this.stats.delayHours += dt / 3600;
        }
      }
    }

    this.advanceLanes();
  }

  private accelFor(car: Car, ahead: Car | null): number {
    const lane = this.net.lanes[car.lane];

    // Ease off before a turn rather than braking on entry to it.
    let v0 = this.speedOf(car.lane);
    const nextId = car.route[car.routeIdx + 1];
    if (nextId !== undefined && lane.length - car.s < 18) {
      v0 = Math.min(v0, this.speedOf(nextId));
    }

    let gap = Infinity;
    let leaderV = 0;

    if (ahead) {
      gap = ahead.s - car.s - CAR_LENGTH;
      leaderV = ahead.v;
    } else {
      // Front of its queue: look across lane boundaries so queues propagate
      // back through connectors instead of stopping at the junction mouth.
      let dist = lane.length - car.s;
      for (let k = car.routeIdx + 1; k < car.route.length && dist < LOOKAHEAD; k++) {
        const nl = this.net.lanes[car.route[k]];
        const rearId = nl.cars[nl.cars.length - 1];
        if (rearId !== undefined) {
          gap = dist + this.cars[rearId].s - CAR_LENGTH;
          leaderV = this.cars[rearId].v;
          break;
        }
        dist += nl.length;
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
        } else if (this.yieldBlockedAt(nextId, junction) !== null) {
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
        const blockAt = this.yieldBlockedAt(lane.id, junction, car.s);
        if (blockAt !== null) {
          const stopGap = blockAt - CONFLICT_RADIUS - car.s;
          if (stopGap < gap) {
            gap = stopGap;
            leaderV = 0;
          }
        }
      }
    }

    return idmAccel(car.v, gap, leaderV, v0);
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
      if (target.sSelf <= from + CONFLICT_RADIUS) continue;

      // Traffic that is itself held at a red is no reason to wait.
      if (!junction.green.has(target.connector)) continue;

      let blocked = false;

      // Anyone already in the box on that movement and not yet past the point
      // where the two paths meet.
      const crossing = this.net.lanes[target.connector];
      for (const carId of crossing.cars) {
        if (this.cars[carId].s <= target.sAt + CAR_LENGTH) {
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
          if (approach < CRITICAL_GAP) blocked = true;
        }
      }

      if (!blocked) continue;
      if (earliest === null || target.sSelf < earliest) earliest = target.sSelf;
    }

    return earliest;
  }

  private speedOf(laneId: LaneId): number {
    const lane = this.net.lanes[laneId];
    if (lane.kind !== "connector" || !lane.turn) return IDM.v0;
    return TURN_SPEED[lane.turn];
  }

  private advanceLanes(): void {
    for (const lane of this.net.lanes) {
      // Only the front car can leave, and it always leaves from index 0.
      while (lane.cars.length > 0) {
        const car = this.cars[lane.cars[0]];
        if (car.s <= lane.length) break;

        lane.cars.shift();

        if (car.routeIdx >= car.route.length - 1) {
          this.retire(car, true);
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
