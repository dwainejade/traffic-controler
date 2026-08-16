import type { LevelDef } from "../sim/types";
import { CURVE_TEST } from "./curveTest";
import { LANE_TEST } from "./laneTest";
import { T_JUNCTION } from "./tJunction";
import { CROSSROADS } from "./crossroads";
import { FIVE_WAYS } from "./fiveWays";
import { FOUR_CORNERS } from "./fourCorners";
import { OSM_LEVELS } from "./osm";

/**
 * Ordered by junction complexity, then by network complexity.
 *
 *   1. T-junction    — 3 arms, 3 phases, light traffic
 *   2. Crossroads    — 4 arms, 4 phases, protected left turns
 *   3. Five Ways     — 5 oblique arms, 7 phases, clearance dominates
 *   4. Four Corners  — four junctions, and the first that needs linking
 *   5. …then real places
 *
 * The first three teach one junction at a time; Four Corners introduces a
 * network, which is where offsets and shared cycles start to matter.
 *
 * The generated city that used to sit at the end is gone. Half a square
 * kilometre of invented Manhattan looked like a city from far enough away and
 * like nothing at all up close, and detail is worth more than extent: the
 * imported areas below are a fraction of the size and carry real lane counts,
 * real one-way couplets and real bus lanes. `cityGen.ts` is still in the tree
 * if that judgement ever needs revisiting.
 */
export const LEVELS: LevelDef[] = [
  T_JUNCTION,
  CROSSROADS,
  FIVE_WAYS,
  FOUR_CORNERS,
  // Real places, imported from OpenStreetMap. One level per cached area, so
  // they appear and disappear with the JSON files in ./osm.
  ...OSM_LEVELS,
  // Dev builds carry the geometry and lane-changing proving grounds as extra
  // levels; neither ships. (`?.` so the sim harness can import this file under
  // plain Node.)
  ...(import.meta.env?.DEV ? [CURVE_TEST, LANE_TEST] : []),
];

export { T_JUNCTION, CROSSROADS, FIVE_WAYS, FOUR_CORNERS, LANE_TEST };
