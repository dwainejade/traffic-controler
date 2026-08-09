import { pairKey, type ConflictMap } from "./conflicts";
import type { Arm, LaneId, Network } from "./network";
import type { NodeId } from "./types";

/**
 * A phase is just a set of connectors allowed to run green together. A phase is
 * *illegal* if any two of its connectors cross — that single rule will later
 * power the phase editor, the tutorial and the crash system alike.
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

/** Clearance timings. These are what stop a phase change from being a teleport. */
export const TIMING: Timing = {
  minGreen: 3.0,
  /**
   * Shorter than a real junction's. Realistic clearance (2.6s + 1.8s) burns
   * ~24% of a four-phase cycle, which reads as the game being sluggish rather
   * than as the player being slow.
   */
  amber: 2.2,
  allRed: 1.2,
};

/** Compass letter for a direction leaving a junction. -z is north on these maps. */
function bearing(out: { x: number; z: number }): string {
  if (Math.abs(out.z) >= Math.abs(out.x)) return out.z < 0 ? "N" : "S";
  return out.x > 0 ? "E" : "W";
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
 * A phase is a set of movements no two of which cross — an independent set in
 * that graph — and covering every movement in as few phases as possible is
 * graph colouring. Deriving phases this way rather than from geometry is what
 * makes arbitrary junctions work: T-junctions, five-way, staggered and skewed
 * all fall out of the same rule.
 *
 * The previous approach paired arms that pointed roughly opposite, which held
 * for a symmetric cross and silently emitted *conflicting* phases for anything
 * else.
 */
export function buildPhases(
  net: Network,
  nodeId: NodeId,
  conflicts: ConflictMap,
): Phase[] {
  const arms = net.armsByJunction.get(nodeId) ?? [];
  const movements = net.connectorsByJunction.get(nodeId) ?? [];
  if (movements.length === 0) return [];

  const crosses = (a: LaneId, b: LaneId) => conflicts.pairs.has(pairKey(a, b));

  const degree = new Map<LaneId, number>();
  for (const a of movements) {
    degree.set(a, movements.filter((b) => b !== a && crosses(a, b)).length);
  }

  /*
   * Order matters more than the colouring itself.
   *
   * Straight movements are seeded first so that opposing throughs — which never
   * conflict — land in the same phase and each phase serves two approaches at
   * once. Colouring purely by conflict degree puts the heavily-conflicting left
   * turns in first, and a left blocks the opposing through, which silently
   * produces split phasing: four phases each serving a single arm, at roughly
   * half the capacity. Separating protected lefts is exactly why real junctions
   * are phased this way.
   */
  const rank: Record<string, number> = { straight: 0, right: 1, left: 2 };
  const ordered = [...movements].sort(
    (a, b) =>
      rank[net.lanes[a].turn ?? "left"] - rank[net.lanes[b].turn ?? "left"] ||
      degree.get(b)! - degree.get(a)! ||
      a - b,
  );

  const cores: LaneId[][] = [];
  for (const movement of ordered) {
    const fit = cores.find((g) => g.every((m) => !crosses(movement, m)));
    if (fit) fit.push(movement);
    else cores.push([movement]);
  }

  // A movement may also run in any *other* phase it doesn't conflict with. That
  // costs nothing — the phase is green regardless — and serves the movement more
  // often, which is exactly why real signals run right turns in several phases.
  const groups = cores.map((core) => {
    const full = [...core];
    for (const movement of movements) {
      if (full.includes(movement)) continue;
      if (full.every((m) => !crosses(movement, m))) full.push(movement);
    }
    return full;
  });

  // Augmenting can leave a phase that serves nothing another phase doesn't.
  const keep = groups
    .map((_, i) => i)
    .filter(
      (i) =>
        !groups.some(
          (other, k) =>
            k !== i &&
            (other.length > groups[i].length ||
              (other.length === groups[i].length && k < i)) &&
            groups[i].every((m) => other.includes(m)),
        ),
    );

  const used = new Map<string, number>();
  return keep.map((index, i) => {
    /*
     * Name a phase by what it *uniquely* serves.
     *
     * Right turns conflict with almost nothing, so augmentation puts them in
     * nearly every phase — naming from the whole set yields "E–N–S–W through"
     * for all of them. The movements only this phase greens are precisely the
     * reason it exists, and are what the player needs in order to decide how
     * much time to give it.
     */
    const exclusive = groups[index].filter(
      (m) => !keep.some((k) => k !== index && groups[k].includes(m)),
    );
    const base = nameFor(net, arms, exclusive.length > 0 ? exclusive : cores[index]);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return {
      id: i,
      // Names are React keys and group-mapping handles, so they must be unique.
      name: seen === 0 ? base : `${base} ${seen + 1}`,
      connectors: [...groups[index]].sort((a, b) => a - b),
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
 * Starting program: every phase gets the same green time.
 *
 * Deliberately mediocre. An even split serves the low-demand left-turn phases
 * as generously as the heavy through phases, which measurably wastes cycle time
 * — so improving on this default is the game.
 */
export const DEFAULT_GREEN = 12;

export function defaultProgram(phaseCount: number): Program {
  return { splits: new Array(phaseCount).fill(DEFAULT_GREEN) };
}

export function createJunction(
  net: Network,
  nodeId: NodeId,
  conflicts: ConflictMap,
): Junction {
  const phases = buildPhases(net, nodeId, conflicts);
  const j: Junction = {
    nodeId,
    phases,
    timing: { ...TIMING },
    program: defaultProgram(phases.length),
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

export function stepJunction(j: Junction, clock: number, program: Program): void {
  const at = evaluateProgram(j.phases.length, program, j.timing, clock, j.offset);
  j.current = at.phase;
  j.state = at.state;
  j.timer = at.remaining;
  refreshGreen(j);
}
