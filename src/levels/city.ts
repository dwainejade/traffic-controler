import { generateCity } from "./cityGen";
import type { LevelDef, MapNode } from "../sim/types";

const SEED = 20260815;

/**
 * The city. Not a level with a win condition — a place that keeps running.
 *
 * A 7x7 grid thinned into an irregular street pattern: around four dozen
 * signalised junctions, curved streets, blocks traced from the faces of the
 * street graph itself, and a one-way couplet through the middle. Traffic enters
 * from every edge and never stops arriving.
 *
 * You cannot watch fifty junctions at once, which is the whole point: the queue
 * tint and the congestion list tell you where the city is struggling, and you go
 * there and re-time that junction.
 */
/*
 * Manhattan is the reference, and the two things worth stealing from it are
 * both about the water rather than the grid: the island is long and narrow, and
 * its grid is turned about 29° off north so the shoreline crosses the streets at
 * an angle that changes as it goes. That is what stops a grid reading as graph
 * paper — not the streets, but where they get cut off.
 *
 * The grid is generated oversized and then clipped to the shore, so the number
 * of junctions that survive is whatever fits, and the edge of the city is an
 * organic curve with truncated blocks along it.
 */
const MANHATTAN_ANGLE = (29 * Math.PI) / 180;

const generated = generateCity({
  seed: SEED,
  /*
   * The grid is deliberately generated larger than the island in every
   * direction. Clipping is what shapes the city, so the grid has to overflow
   * the shore everywhere — size it to the island and the corners come up short,
   * leaving a bare band of land with no streets on it.
   */
  /*
   * 14 avenues by 46 cross-streets before clipping; roughly 400 junctions
   * survive the water. The block proportion is the point: 190m between avenues
   * against 96m between streets, so blocks run long across the island the way
   * Manhattan's do. Square blocks cannot read as Manhattan however many you
   * draw — it was the single biggest thing making the city look small.
   */
  /*
   * The grid is generated well oversized in both axes and then clipped to the
   * shore — 21x75 goes in, about 400 junctions come out. Sizing the grid to the
   * island instead leaves bare land around the edges, because the corners of a
   * rectangle never reach the sides of an ellipse.
   */
  cols: 17,
  rows: 95,
  block: 140,
  blockX: 175,
  blockZ: 82,

  /*
   * The grid is rigid on purpose.
   *
   * Manhattan's street plan is one of the most uniform ever built — the 1811
   * Commissioners' Plan laid it out as a pure rectangular lattice, and every
   * irregularity you can see from above comes from something else cutting it:
   * the shoreline, the park, Broadway. Jittering the spacing, dropping links
   * and bowing the streets all read as a *different* kind of city, and they
   * were what made the blocks look arbitrary.
   *
   * So: no thinning, almost no jitter, no curves. The shore does the work.
   */
  jitter: 0.03,
  thin: 0,
  tail: 60,
  oneWayAvenues: true,
  /*
   * Central Park: a long ribbon, not a square. The real one is four avenues
   * wide and fifty-one streets long — better than 1:5 — and that shape is most
   * of how it is recognised from above. Set in the upper half of the island,
   * with avenues running its full length on both flanks.
   */
  park: { col0: 7, col1: 10, row0: 29, row1: 57 },
  island: {
    /*
     * Manhattan is about 1:6 — a sliver, not a blob. Sitting it on the
     * diagonal lets a long island still fill a landscape frame, which is why
     * the 29 degree rotation earns its keep twice over. 1:3.4 is the
     * compromise: unmistakably a sliver, still legible end to end on screen.
     */
    longHalf: 2900,
    shortHalf: 860,
    angle: MANHATTAN_ANGLE,
    // Enough dry land that a junction box and its approaches sit inland.
    margin: 16,
    bridges: 18,
    /*
     * Broad at one end, narrowing to the other. Kept mild: at 0.55 the narrow
     * third of the island was too thin to fit a junction and its margin, so it
     * came out as bare land with no streets on it at all — a taper you cannot
     * build on is just a hole in the map.
     */
    taper: 0.34,
    // The two rivers. Wide enough to read as water, short enough to bridge.
    channel: 230,
  },
});

/*
 * Directional demand — the reason the city is a puzzle rather than a texture.
 *
 * With uniform demand an even split is, measurably, near-optimal: every
 * approach carries the same flow, so there is nothing to decide. Weighting the
 * west and east edges several times the side streets creates a real arterial
 * across the map, and with it a plan that favours the arterial genuinely beats
 * an even one, and offsets along it genuinely beat no offsets.
 *
 * Destinations are map-edge sources — there is no interior sink — so "downtown
 * attraction" is expressed as heavy east-west OD pairs whose shortest routes
 * cross the core.
 */
const ARTERIAL_IN = 7;
const ARTERIAL_OUT = 7;
const COUNTER = 2.5;

/*
 * The arterial is a *corridor*, not a compass direction.
 *
 * Measured: weighting every west source against every east one spreads the
 * extra flow evenly over all seven east-west streets, so no street is busier
 * than its neighbours and favouring east-west green at every junction simply
 * starves the cross traffic — it came out 1.1 veh-hours *worse* than an even
 * split. Concentrating the same demand on the three central rows builds one
 * genuinely loaded corridor, which is what gives re-timing something to bite
 * on. Source ids carry their row: src_w_<row>_<col>.
 */
const ARTERIAL_ROWS = new Set([2, 3, 4]);

const rowOf = (id: string): number => Number(id.split("_")[2]);

const nodes: MapNode[] = generated.nodes.map((node) => {
  if (node.kind !== "source") return node;
  const onArterial = ARTERIAL_ROWS.has(rowOf(node.id));
  if (node.id.startsWith("src_w")) {
    return {
      ...node,
      spawnWeight: onArterial ? ARTERIAL_IN : 1,
      attractWeight: onArterial ? COUNTER : 1,
    };
  }
  if (node.id.startsWith("src_e")) {
    return {
      ...node,
      spawnWeight: onArterial ? COUNTER : 1,
      attractWeight: onArterial ? ARTERIAL_OUT : 1,
    };
  }
  return node;
});

export const CITY: LevelDef = {
  ...generated,
  nodes,

  name: "Downtown",
  sandbox: true,

  /*
   * Endless: no quota, no clock, no failure. Collisions are logged and towed.
   * Delay is still measured — it is the honest read on how well the city is
   * running — it just isn't a budget you can bust.
   */
  quota: 0,
  timeLimit: 0,

  /*
   * Base arrival rate, cars per second across every entry. Held where the
   * network is busy and visibly uneven without tipping: junction capacity is
   * about 2300 veh/h and a lane saturates near 1543 veh/h, and demand pushed
   * past that stops arriving at the kerb at all, which would quietly make the
   * whole map a lie.
   */
  /*
   * Measured ceiling for this map: at 1.5 cars/s every arrival still gets onto
   * the network, and at 2.5/s nearly half are turned away at the kerb because
   * the sixteen crossings are themselves saturated. Demand that never lands is
   * demand the player cannot see or fix, so the base rate is set so even the
   * peak of the rush (x1.38) stays just under that line.
   */
  demand: 1.08,

  /*
   * A rush that comes around again. Peak is a little over a third above the
   * base rate — enough that queues visibly build on the arterial and then
   * drain, which is the pattern worth watching, and worth re-timing for.
   */
  /*
   * Long enough for the city to reach the state it actually lives in. Measured:
   * active climbs to a plateau near 330 cars and holds there, but it takes
   * around ten simulated minutes to get there — warm for 35s, as the small
   * junctions do, and the city opens with seventeen cars on it. The sim runs
   * several hundred times faster than real time, so this costs about a second.
   */
  warmupSeconds: 900,

  /*
   * A rush that comes around again, and which the city opens in the middle of
   * rather than at its quietest — warmup pre-runs at whatever the t=0
   * multiplier is, so starting the profile in a trough means opening on a
   * half-empty map and waiting minutes for it to fill.
   */
  rush: {
    loop: true,
    points: [
      { t: 0, mult: 1.15 },
      { t: 150, mult: 1.38 },
      { t: 330, mult: 0.95 },
      { t: 470, mult: 0.78 },
      { t: 620, mult: 1.15 },
    ],
  },
};
