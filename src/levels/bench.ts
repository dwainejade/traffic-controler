import { generateCity } from "./cityGen";
import { scatterLevel } from "../render/scatter";
import type { BuildingFootprint, LevelDef } from "../sim/types";

/**
 * Benchmark cities: a plain grid at any size you ask for.
 *
 * These exist to answer one question — how much ground can be on screen at
 * 60fps — and that question cannot be answered with the levels that ship. The
 * largest of those is Dumbo at `half` 636, and an import much bigger is
 * minutes of Overpass away and then dependent on whatever happens to be mapped
 * there. A generator gives the same city at any extent, instantly, so a change
 * to the renderer can be measured against the size it was meant to fix.
 *
 * Rectangular and unclipped, unlike `city.ts`, which puts its grid on an island
 * and takes whatever survives the water. An island is the better-looking city
 * and the worse instrument: what is being measured here is metres of map, and
 * that has to be the number going in rather than a consequence of where a
 * coastline happened to fall.
 *
 * Nothing is persisted and nothing ships — `addBenchLevel` is reachable only
 * from the dev console.
 */

/**
 * Block spacing, chosen to land on the junction density of the real imports
 * rather than on a round number: 140 x 80 gives ~70 junctions/km², and Dumbo —
 * the densest thing that ships — measures ~69. A benchmark at half the true
 * density would report a ceiling twice as high as the real one.
 */
const BLOCK_X = 140;
const BLOCK_Z = 80;

/** Stub from a boundary junction out to its map-edge source. */
const TAIL = 60;

/**
 * `generateCity` frames on the junctions it placed and adds 40, so the grid has
 * to be sized back through both of those to land on a requested `half`.
 */
function gridFor(half: number): { cols: number; rows: number } {
  const reach = half - 40;
  return {
    cols: Math.max(3, Math.round(1 + (2 * (reach - TAIL)) / BLOCK_X)),
    rows: Math.max(3, Math.round(1 + (2 * (reach - TAIL)) / BLOCK_Z)),
  };
}

/**
 * Turn the procedural boxes into surveyed outlines.
 *
 * Worth the detour: `Scene` draws scattered boxes through `Buildings` — one
 * instanced call — and surveyed footprints through `Footprints`, which extrudes
 * every outline and merges them. Those are entirely different costs, and every
 * imported area takes the second path. A benchmark on the instanced path would
 * measure a renderer nobody is using at the size in question.
 */
function footprintsFrom(level: LevelDef): BuildingFootprint[] {
  const { buildings } = scatterLevel(level);

  return buildings.map((b) => {
    const cos = Math.cos(b.rot);
    const sin = Math.sin(b.rot);
    const hw = b.w / 2;
    const hd = b.d / 2;
    const corner = (dx: number, dz: number): [number, number] => [
      b.x + dx * cos - dz * sin,
      b.z + dx * sin + dz * cos,
    ];

    return {
      polygon: [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)],
      height: b.h,
      tint: b.tint,
    };
  });
}

/** Levels already built this session, so a re-request keeps object identity. */
const cache = new Map<number, LevelDef>();

/**
 * Build (or recall) the benchmark city of a given half-extent.
 *
 * Demand is zero and the warmup is skipped on purpose. This measures the
 * *renderer*, and a map that spends its first seconds warming several thousand
 * junctions would measure the simulation instead — which is a separate problem
 * with a separate fix. Traffic comes back once there is something to say about
 * it.
 */
export function benchLevel(half: number): LevelDef {
  const cached = cache.get(half);
  if (cached) return cached;

  const { cols, rows } = gridFor(half);
  const generated = generateCity({
    seed: 20260815,
    cols,
    rows,
    block: BLOCK_X,
    blockX: BLOCK_X,
    blockZ: BLOCK_Z,
    // A rigid grid: every irregularity is one more thing that could explain a
    // difference between two runs.
    jitter: 0.03,
    thin: 0,
    tail: TAIL,
    oneWayAvenues: true,
  });

  const level: LevelDef = {
    ...generated,
    id: `bench-${half}`,
    name: `Bench ${half}m`,
    sandbox: true,
    quota: 0,
    timeLimit: 0,
    demand: 0,
    warmupSeconds: 0,
  };
  level.footprints = footprintsFrom(level);

  cache.set(half, level);
  return level;
}
