import { pairKey, type Priority } from "./conflicts";
import type { Arm, LaneId, Network } from "./network";
import type { NodeId } from "./types";

/**
 * A phase is just a set of connectors allowed to run green together. A phase is
 * *illegal* if any two of its connectors cross in a way neither can yield out
 * of — see `buildPriority`, which decides which crossings those are.
 */
export type Phase = {
  id: number;
  name: string;
  connectors: LaneId[];
};

export type SignalState = "green" | "amber" | "allRed";

export type Timing = { minGreen: number; amber: number; allRed: number };

/**
 * A signal program: how long each phase holds green.
 *
 * Red is never set directly — at a junction, one direction's red *is* the other
 * directions' green, so specifying both would be self-contradictory. The cycle
 * is a partition, and the only free variable is how the green time divides.
 */
export type Program = {
  /** Green seconds per phase, indexed to match `Junction.phases`. */
  splits: number[];
};

/** Fixed cost of one phase change: amber plus the all-red clearance after it. */
export function clearanceCost(timing: Timing): number {
  return timing.amber + timing.allRed;
}

/** Total green time available to divide up. */
export function greenTotal(program: Program): number {
  return program.splits.reduce((a, b) => a + Math.max(0, b), 0);
}

/**
 * Cycle length, derived rather than stored. Storing it alongside the splits
 * invites the two disagreeing; here the splits are always authoritative.
 */
export function cycleOf(program: Program, timing: Timing): number {
  return greenTotal(program) + program.splits.length * clearanceCost(timing);
}

export type Junction = {
  nodeId: NodeId;
  phases: Phase[];
  /** Per-junction so later controller tiers can tune their own clearance. */
  timing: Timing;
  /** This junction's own program. Ignored while it follows a group's. */
  program: Program;
  /** Start delay within the cycle. What actually creates a green wave. */
  offset: number;
  /** Group whose parent program this junction follows, if any. */
  groupId: string | null;
  /** Index into `phases` currently running. */
  current: number;
  state: SignalState;
  /** Seconds left in the current window, for the HUD. */
  timer: number;
  /** Connectors enterable right now. Recomputed each step. */
  green: Set<LaneId>;
};

/**
 * Clearance timings, taken from the standard traffic-engineering formulas
 * rather than chosen by feel, and evaluated at the 25 mph New York City default
 * limit (11.2 m/s):
 *
 *   amber  = reaction + v / (2a)        = 1.0 + 11.2 / (2 x 3.0)  = 2.9s
 *   allRed = (junction width + car) / v = (19 + 4.4) / 11.2       = 2.1s
 *
 * Amber is floored at the 3.0s minimum every US signal manual specifies, which
 * binds here: the formula's 2.9s is below it. The lower design speed does not
 * buy back much clearance, then — 5.1s a change against 5.0s — because a slower
 * car also takes longer to cross the box, and the two effects nearly cancel.
 *
 * That five seconds per phase change, serving nobody, is the whole reason real
 * cycles run 90-120s: long cycles amortise the loss and short ones bleed
 * capacity. Making it honest is what gives cycle length its shape as a decision.
 */
export const TIMING: Timing = {
  minGreen: 3.0,
  amber: 3.0,
  allRed: 2.1,
};

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/**
 * Compass bearing for a direction leaving a junction; -z is north on these maps.
 *
 * Eight points rather than four: a junction with five or more arms has to give
 * two of them the same letter under a four-point rose, and phase names then
 * collide into "W left" and "W left 2", which tells the player nothing.
 */
function bearing(out: { x: number; z: number }): string {
  const deg = (Math.atan2(out.x, -out.z) * 180) / Math.PI;
  const index = Math.round(((deg + 360) % 360) / 45) % 8;
  return COMPASS[index];
}

/** Human label for a set of movements, from the arms they leave and the turns they make. */
function nameFor(net: Network, arms: Arm[], group: LaneId[]): string {
  const bearings = new Set<string>();
  const turns = new Set<string>();

  for (const id of group) {
    const connector = net.lanes[id];
    const source = connector.from !== null ? net.lanes[connector.from] : null;
    const arm = source ? arms.find((a) => a.roadId === source.roadId) : undefined;
    if (arm) bearings.add(bearing(arm.out));
    if (connector.turn) turns.add(connector.turn);
  }

  const where = [...bearings].sort().join("–") || "?";
  const what =
    turns.size === 1
      ? turns.has("left")
        ? "left"
        : turns.has("right")
          ? "right"
          : "through"
      : turns.has("left")
        ? "mixed"
        : "through";

  return `${where} ${what}`;
}

/**
 * Build a signal plan from the junction's conflict graph.
 *
 * **A phase is a set of whole approaches, not a set of movements.** An approach
 * has one signal head showing one colour, and on a green ball every movement off
 * that approach may go — straight, left and right together, the left giving way
 * to oncoming. When the head is red, *nothing* off that approach may go.
 *
 * That second half is the part worth stating plainly, because an earlier
 * version got it wrong in a way that is invisible unless you look: it colour-ed
 * individual movements and then let any movement join any other phase it did
 * not conflict with. Right turns conflict with almost nothing, so they were
 * being served in every phase — an approach sitting at a red would still be
 * releasing its right-turning traffic. That is right-turn-on-red, which New
 * York prohibits outright, and it also made the signal head over a red approach
 * light up green.
 *
 * So arms are what get coloured. Two arms may share a phase when no movement of
 * one *hard*-conflicts with any movement of the other; a permissive left across
 * oncoming traffic is not a hard conflict and so does not split them. On a
 * crossroads that gives exactly two phases — north with south, then east with
 * west — and every other layout, from a T to a five-way, falls out of the same
 * rule without special cases.
 */
export function buildPhases(
  net: Network,
  nodeId: NodeId,
  priority: Priority,
): Phase[] {
  const arms = net.armsByJunction.get(nodeId) ?? [];
  const movements = net.connectorsByJunction.get(nodeId) ?? [];
  if (movements.length === 0) return [];

  // Only arms that actually release traffic need a green.
  const live = arms.filter((arm) => arm.connectorIds.length > 0);
  if (live.length === 0) return [];

  const crosses = (a: LaneId, b: LaneId) => priority.hard.has(pairKey(a, b));

  /** Two approaches clash when any movement off one hard-conflicts with any off the other. */
  const armsClash = (a: Arm, b: Arm) =>
    a.connectorIds.some((m) => b.connectorIds.some((n) => crosses(m, n)));

  const clashCount = new Map<Arm, number>();
  for (const arm of live) {
    clashCount.set(arm, live.filter((other) => other !== arm && armsClash(arm, other)).length);
  }

  /*
   * Most-constrained first. An arm that clashes with everything has to seed its
   * own phase, and seeding it early leaves the freer arms to fill in around it;
   * taking the easy arms first strands the hard one in a phase of its own at
   * the end and costs an extra phase change every cycle.
   */
  const ordered = [...live].sort(
    (a, b) => clashCount.get(b)! - clashCount.get(a)! || a.roadId.localeCompare(b.roadId),
  );

  const groups: Arm[][] = [];
  for (const arm of ordered) {
    const fit = groups.find((g) => g.every((other) => !armsClash(arm, other)));
    if (fit) fit.push(arm);
    else groups.push([arm]);
  }

  const used = new Map<string, number>();
  return groups.map((group, i) => {
    const connectors = group.flatMap((arm) => arm.connectorIds);
    const base = nameFor(net, arms, connectors);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return {
      id: i,
      // Names are React keys and group-mapping handles, so they must be unique.
      name: seen === 0 ? base : `${base} ${seen + 1}`,
      connectors: [...connectors].sort((a, b) => a - b),
    };
  });
}

/** Movements no phase ever serves. Any result here strands cars forever. */
export function uncoveredMovements(
  net: Network,
  nodeId: NodeId,
  phases: Phase[],
): LaneId[] {
  const served = new Set(phases.flatMap((p) => p.connectors));
  return (net.connectorsByJunction.get(nodeId) ?? []).filter(
    (id) => !served.has(id),
  );
}

/**
 * Cycle length every junction starts on, whatever its shape.
 *
 * Targeting a *cycle* rather than a fixed green per phase is what keeps complex
 * junctions sane. A fixed 20s green puts a three-phase T on 75s and a seven-phase
 * five-way on 175s — well beyond the ~120s ceiling real practice observes. Real
 * engineers do the reverse: pick a cycle, then divide it. A junction with more
 * phases gets shorter greens, not a longer wait.
 *
 * 60s is the standard New York local cycle, and it is also where the measured
 * numbers put it. This was 100s, which suited the old four-phase protected
 * plans and is far too long for the two-phase ones that replaced them: a
 * two-phase junction on a 100s cycle spends 45s of green on each direction,
 * most of it on an approach that emptied twenty seconds earlier, while the
 * other direction queues. Traced over twelve minutes on Rogers Avenue at 0.9
 * cars/s, cars on the map climbed 76 → 173 and network delay 15s → 76s and both
 * were still rising — the network was simply not clearing. At 60s it settles at
 * about 140 cars and 42s, and at 45s a little better again.
 *
 * The default is left deliberately mediocre rather than optimal: an even split
 * on a stable cycle is something the player can beat, which is the game.
 */
export const TARGET_CYCLE = 60;

export function defaultProgram(phaseCount: number, timing: Timing): Program {
  if (phaseCount === 0) return { splits: [] };
  const usable = TARGET_CYCLE - phaseCount * clearanceCost(timing);
  // An even split is deliberately mediocre — it serves the light left-turn
  // phases as generously as the heavy through ones, so improving on it is the
  // game. The floor matters on many-phase junctions, where the target cycle
  // cannot be met without starving every phase.
  const green = Math.max(MIN_GREEN, usable / phaseCount);
  return { splits: new Array(phaseCount).fill(green) };
}

/** Shortest green worth giving a phase; below this the queue barely moves. */
export const MIN_GREEN = 6;

export function createJunction(
  net: Network,
  nodeId: NodeId,
  priority: Priority,
): Junction {
  const phases = buildPhases(net, nodeId, priority);
  const j: Junction = {
    nodeId,
    phases,
    timing: { ...TIMING },
    program: defaultProgram(phases.length, { ...TIMING }),
    offset: 0,
    groupId: null,
    current: 0,
    state: "green",
    timer: 0,
    green: new Set(),
  };
  refreshGreen(j);
  return j;
}

/** Clear runtime state without touching the player's program. */
export function resetJunctionRuntime(j: Junction): void {
  j.current = 0;
  j.state = "green";
  j.timer = 0;
  refreshGreen(j);
}

function refreshGreen(j: Junction): void {
  j.green.clear();
  // Only a settled green phase admits new vehicles. During amber and all-red
  // the box must drain — cars already inside a connector keep going.
  if (j.state === "green") {
    for (const c of j.phases[j.current].connectors) j.green.add(c);
  }
}

/**
 * Where a program puts a junction at a given moment.
 *
 * Signals are derived from a shared clock rather than served from a request
 * queue. A request-driven machine drifts, and drift makes offsets meaningless —
 * which would make coordination between junctions impossible. Here every cycle
 * is exactly periodic, and clearance is structural: amber and all-red are built
 * into every phase window, so no program can ever skip them.
 */
export function evaluateProgram(
  phaseCount: number,
  program: Program,
  timing: Timing,
  clock: number,
  offset: number,
): { phase: number; state: SignalState; remaining: number } {
  const cycle = cycleOf(program, timing);
  if (cycle <= 0 || phaseCount === 0) {
    return { phase: 0, state: "allRed", remaining: 0 };
  }

  let p = (((clock - offset) % cycle) + cycle) % cycle;

  for (let i = 0; i < phaseCount; i++) {
    const green = Math.max(0, program.splits[i] ?? 0);

    if (p < green) return { phase: i, state: "green", remaining: green - p };
    p -= green;

    if (p < timing.amber) return { phase: i, state: "amber", remaining: timing.amber - p };
    p -= timing.amber;

    if (p < timing.allRed) return { phase: i, state: "allRed", remaining: timing.allRed - p };
    p -= timing.allRed;
  }

  // Only reachable through floating-point slack at the very end of a cycle.
  return { phase: phaseCount - 1, state: "allRed", remaining: 0 };
}

/**
 * Seconds until a movement's next green begins, and 0 while it is already
 * running. This is what a countdown head displays.
 *
 * Walked forward through the phase windows rather than measured against the
 * clock, because "when do I go" is not a property of the cycle but of one
 * approach's place in it: every phase in between costs its green plus its
 * clearance, and a driver waiting at a red is counting exactly that.
 */
export function timeToNextGreen(
  j: Junction,
  program: Program,
  serves: (phaseIndex: number) => boolean,
): number {
  const count = j.phases.length;
  if (count === 0) return 0;
  if (j.state === "green" && serves(j.current)) return 0;

  // Whatever is left of the window running now.
  let t = j.timer;
  let phase = j.current;
  let state: SignalState = j.state;

  // Every phase has three windows, so one full lap is an upper bound.
  for (let guard = 0; guard < count * 3 + 3; guard++) {
    if (state === "green") state = "amber";
    else if (state === "amber") state = "allRed";
    else {
      state = "green";
      phase = (phase + 1) % count;
    }

    if (state === "green") {
      if (serves(phase)) return t;
      t += Math.max(0, program.splits[phase] ?? 0);
    } else {
      t += state === "amber" ? j.timing.amber : j.timing.allRed;
    }
  }

  return t;
}

export function stepJunction(j: Junction, clock: number, program: Program): void {
  const at = evaluateProgram(j.phases.length, program, j.timing, clock, j.offset);
  j.current = at.phase;
  j.state = at.state;
  j.timer = at.remaining;
  refreshGreen(j);
}
