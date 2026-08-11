import type { LevelDef, MapNode, RoadDef, ZoneDef } from "../sim/types";

/** Spacing between adjacent junctions. */
const BLOCK = 78;
/** Distance from the outer junctions to the map-edge sources. */
const TAIL = 62;

const H = BLOCK / 2;

/**
 * Milestone 5: a 2x2 grid. Four junctions, eight map-edge sources.
 *
 * The road joining two junctions is a single lane in the simulation, so when it
 * fills the upstream junction has nowhere to send cars — spillback, and with it
 * gridlock and the box-blocking crash, become reachable for the first time.
 */
const junctions: MapNode[] = [
  { id: "j00", pos: [-H, -H], kind: "junction" },
  { id: "j10", pos: [H, -H], kind: "junction" },
  { id: "j01", pos: [-H, H], kind: "junction" },
  { id: "j11", pos: [H, H], kind: "junction" },
];

const sources: MapNode[] = [
  { id: "n0", pos: [-H, -H - TAIL], kind: "source" },
  { id: "n1", pos: [H, -H - TAIL], kind: "source" },
  { id: "s0", pos: [-H, H + TAIL], kind: "source" },
  { id: "s1", pos: [H, H + TAIL], kind: "source" },
  { id: "w0", pos: [-H - TAIL, -H], kind: "source" },
  { id: "w1", pos: [-H - TAIL, H], kind: "source" },
  { id: "e0", pos: [H + TAIL, -H], kind: "source" },
  { id: "e1", pos: [H + TAIL, H], kind: "source" },
];

const roads: RoadDef[] = [
  // Internal links — these are the ones that can spill back.
  { id: "r_top", from: "j00", to: "j10", lanesPerDir: 1 },
  { id: "r_bottom", from: "j01", to: "j11", lanesPerDir: 1 },
  { id: "r_left", from: "j00", to: "j01", lanesPerDir: 1 },
  { id: "r_right", from: "j10", to: "j11", lanesPerDir: 1 },
  // Approaches from the map edge.
  { id: "r_n0", from: "j00", to: "n0", lanesPerDir: 1 },
  { id: "r_n1", from: "j10", to: "n1", lanesPerDir: 1 },
  { id: "r_s0", from: "j01", to: "s0", lanesPerDir: 1 },
  { id: "r_s1", from: "j11", to: "s1", lanesPerDir: 1 },
  { id: "r_w0", from: "j00", to: "w0", lanesPerDir: 1 },
  { id: "r_w1", from: "j01", to: "w1", lanesPerDir: 1 },
  { id: "r_e0", from: "j10", to: "e0", lanesPerDir: 1 },
  { id: "r_e1", from: "j11", to: "e1", lanesPerDir: 1 },
];

const zones: ZoneDef[] = [
  { id: "park_centre", kind: "park", centre: [0, 0], half: [22, 22] },
  { id: "blk_nw", kind: "block", centre: [-H - 42, -H - 34], half: [26, 24] },
  { id: "blk_ne", kind: "block", centre: [H + 42, -H - 34], half: [26, 24] },
  { id: "blk_sw", kind: "block", centre: [-H - 42, H + 34], half: [26, 24] },
  { id: "blk_se", kind: "block", centre: [H + 42, H + 34], half: [26, 24] },
  { id: "blk_n", kind: "block", centre: [0, -H - 44], half: [24, 20] },
  { id: "blk_s", kind: "block", centre: [0, H + 44], half: [24, 20] },
];

export const FOUR_CORNERS: LevelDef = {
  id: "four-corners",
  name: "Four Corners",
  half: H + TAIL,
  seed: 20260810,
  /*
   * 0.6 veh/s = 2160 veh/h, ~30s mean delay (level-of-service C).
   *
   * Lowered from 1.1 because the grid was a lottery at that load: outcomes were
   * bimodal, with a standard deviation of 34-52 cars and individual runs
   * collapsing to 17 delivered when the network tipped into gridlock. Whether
   * you won was mostly luck. At 0.6 the spread falls to 5-9 and the plan is
   * what decides it.
   *
   * Measured over 180s, mean delivered across 14 seeds:
   *   even 20s  (cycle 100s)  →  103  delay 30s
   *   even 12s  (cycle  68s)  →   98  delay 29s
   *   even 34s  (cycle 156s)  →   96  delay 42s
   *
   * Note the 78m blocks cannot support a green wave: two-way progression needs
   * cycle ~= 2x link travel time (11.2s here), and four phases of clearance now
   * cost 20s on their own. Coordination is worth real time only on longer links.
   */
  quota: 21,
  timeLimit: 180,
  demand: 0.15,
  nodes: [...junctions, ...sources],
  roads,
  zones,
};
