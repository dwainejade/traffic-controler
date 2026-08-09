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
  illegalPairsInPhase,
  type ConflictMap,
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
  /** Cars currently on the map. */
  active: number;
  elapsed: number;
  /** Rolling mean of time spent stopped, seconds per delivered car. */
  meanWait: number;
  /** Collisions cleared while observing. Always 0 during a scored run. */
  collisions: number;
};

const EMPTY_STATS = (): WorldStats => ({
  delivered: 0,
  active: 0,
  elapsed: 0,
  meanWait: 0,
  collisions: 0,
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
  private entries: { node: NodeId; lanes: LaneId[] }[] = [];

  constructor(level: LevelDef) {
    this.level = level;
    this.net = buildNetwork(level);
    this.conflicts = buildConflicts(this.net);
    this.routing = buildRouting(this.net);
    this.rand = mulberry32(level.seed ^ 0x9e3779b9);
    this.demand = level.demand;

    for (const node of level.nodes) {
      if (node.kind === "junction") {
        const junction = createJunction(this.net, node.id, this.conflicts);
        this.junctions.set(node.id, junction);

        if (import.meta.env?.DEV) {
          // Generated phases must never contain crossing movements.
          for (const phase of junction.phases) {
            const bad = illegalPairsInPhase(this.conflicts, phase.connectors);
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
    this.entries = [...byNode].map(([node, lanes]) => ({ node, lanes }));
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

    if (this.state !== "running" || this.warming || this.observing) return;

    if (this.stats.delivered >= this.level.quota) {
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

            if (this.observing) {
              // Log it and clear the wreck, so watching can continue.
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
    for (const lane of this.net.lanes) lane.cars.length = 0;

    // Programs, offsets and groups survive a retry — losing the plan you just
    // wrote every time you restart would make the game unplayable.
    this.signalClock = 0;
    for (const j of this.junctions.values()) resetJunctionRuntime(j);

    this.rand = mulberry32(this.level.seed ^ 0x9e3779b9);
  }

  // ---------------------------------------------------------------- spawning

  private spawn(dt: number): void {
    this.spawnAccum += this.demand * dt;

    while (this.spawnAccum >= 1) {
      this.spawnAccum -= 1;

      // Try a few random entries; drop the arrival if they're all backed up.
      let placed = false;
      for (let attempt = 0; attempt < 10 && !placed; attempt++) {
        const entry = this.entries[Math.floor(this.rand() * this.entries.length)];
        if (!entry) break;

        // Send it somewhere other than where it came from.
        const dests = this.routing.destinations.filter((d) => d !== entry.node);
        if (dests.length === 0) continue;
        const dest = dests[Math.floor(this.rand() * dests.length)];
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
        placed = true;
      }
    }
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
        if (car.v < 0.15) car.waited += dt;
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
      if (junction && nextId !== undefined && !junction.green.has(nextId)) {
        const stopGap = lane.stopS - car.s;
        if (stopGap < gap) {
          gap = stopGap;
          leaderV = 0;
        }
      }
    }

    return idmAccel(car.v, gap, leaderV, v0);
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
