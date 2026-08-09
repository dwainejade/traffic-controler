import type { LevelDef } from '../sim/types'

/** Milestone 1: a single 4-way junction with four approaches running to the map edge. */
export const LEVEL_1: LevelDef = {
  id: 'l1',
  name: 'First Light',
  half: 90,
  seed: 20260809,
  /*
   * Measured over 180s, mean delivered across 20 seeds:
   *   cycle 6s each   →   96   (clearance eats the cycle)
   *   even 12s each   →  110   (the starting program)
   *   through 22/7    →  117
   *
   * 180s rather than 90s on purpose. At 90s the spread between the best and
   * worst plan (7.7 cars) was barely above the seed-to-seed noise (4.4), so
   * outcomes were decided more by luck than by the player. Over 180s the plan
   * effect grows to 20.7 against the same noise — roughly a 5:1 signal.
   *
   * Note what this level currently tests: mostly *cycle length*, not split
   * shape. With demand spread evenly over every approach and turn, an even
   * split really is near-optimal. Split shape only becomes interesting once
   * demand is directional.
   */
  quota: 112,
  timeLimit: 180,
  demand: 1.2,
  nodes: [
    { id: 'j0', pos: [0, 0], kind: 'junction' },
    { id: 'n', pos: [0, -90], kind: 'source' },
    { id: 's', pos: [0, 90], kind: 'source' },
    { id: 'e', pos: [90, 0], kind: 'source' },
    { id: 'w', pos: [-90, 0], kind: 'source' },
  ],
  roads: [
    { id: 'r_n', from: 'j0', to: 'n', lanesPerDir: 2 },
    { id: 'r_s', from: 'j0', to: 's', lanesPerDir: 2 },
    { id: 'r_e', from: 'j0', to: 'e', lanesPerDir: 2 },
    { id: 'r_w', from: 'j0', to: 'w', lanesPerDir: 2 },
  ],
  zones: [
    { id: 'park_ne', kind: 'park', centre: [52, -54], half: [30, 26] },
    { id: 'blk_nw', kind: 'block', centre: [-50, -50], half: [30, 30] },
    { id: 'blk_sw', kind: 'block', centre: [-50, 50], half: [30, 30] },
    { id: 'blk_se', kind: 'block', centre: [50, 50], half: [30, 30] },
  ],
}
