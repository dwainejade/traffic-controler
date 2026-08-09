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
  { id: "r_top", from: "j00", to: "j10", lanesPerDir: 2 },
  { id: "r_bottom", from: "j01", to: "j11", lanesPerDir: 2 },
  { id: "r_left", from: "j00", to: "j01", lanesPerDir: 2 },
  { id: "r_right", from: "j10", to: "j11", lanesPerDir: 2 },
  // Approaches from the map edge.
  { id: "r_n0", from: "j00", to: "n0", lanesPerDir: 2 },
  { id: "r_n1", from: "j10", to: "n1", lanesPerDir: 2 },
  { id: "r_s0", from: "j01", to: "s0", lanesPerDir: 2 },
  { id: "r_s1", from: "j11", to: "s1", lanesPerDir: 2 },
  { id: "r_w0", from: "j00", to: "w0", lanesPerDir: 2 },
  { id: "r_w1", from: "j01", to: "w1", lanesPerDir: 2 },
  { id: "r_e0", from: "j10", to: "e0", lanesPerDir: 2 },
  { id: "r_e1", from: "j11", to: "e1", lanesPerDir: 2 },
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

export const LEVEL_2: LevelDef = {
  id: "l2",
  name: "Four Corners",
  half: H + TAIL,
  seed: 20260810,
  /*
   * Measured over 180s, mean delivered across 16 seeds:
   *   cycle 6s each   →  116  (and wildly variable — sd 18, one run as low as 65)
   *   even 12s each   →  139
   *   even 20s each   →  136
   *
   * Extended from 120s for the same reason as level 1: at 120s the plan effect
   * (3.7 cars) was *smaller* than the seed noise (4.9), so the result was
   * essentially a coin toss.
   *
   * The high variance of the short-cycle plan is the real character of this
   * level — a grid at this demand either flows or tips into gridlock, and a
   * cycle that wastes time on clearance is what tips it.
   *
   * Note the 78m blocks cannot support a green wave: two-way progression needs
   * cycle ~= 2x link travel time (11.2s here), and four phases of clearance
   * alone cost 13.6s. Coordination is worth real time only on longer links.
   */
  quota: 130,
  timeLimit: 180,
  demand: 1.1,
  nodes: [...junctions, ...sources],
  roads,
  zones,
};
