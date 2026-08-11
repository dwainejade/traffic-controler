import type { LevelDef } from '../sim/types'

/** Milestone 1: a single 4-way junction with four approaches running to the map edge. */
export const CROSSROADS: LevelDef = {
  id: 'crossroads',
  name: 'Crossroads',
  half: 90,
  seed: 20260809,
  /*
   * Demand is 0.6 veh/s = 2160 veh/h across all four approaches. Measured
   * junction capacity is ~2300 veh/h, so this runs at ~94% of capacity: busy,
   * but not the absurd 4320 veh/h it used to offer, where nearly half of all
   * arrivals were simply dropped at the kerb.
   *
   * At this load the junction sits at ~29s mean delay — level-of-service C,
   * a normal busy urban junction.
   *
   * Measured over 180s, mean delivered across 14 seeds:
   *   even 20s   (cycle 100s)  →  99   delay 29s   (the starting program)
   *   short 10s  (cycle  60s)  →  94   delay 27s
   *   long 40s   (cycle 180s)  →  91   delay 46s
   *   through 30/10            →  85   delay 29s
   *
   * The even split still wins, because demand is spread evenly over every
   * approach and turn — with balanced flow an even split genuinely is close to
   * optimal. Split *shape* only becomes a real decision once demand is
   * directional; today this level really tests cycle length.
   */
  quota: 25,
  timeLimit: 180,
  demand: 0.17,
  nodes: [
    { id: 'j0', pos: [0, 0], kind: 'junction' },
    { id: 'n', pos: [0, -90], kind: 'source' },
    { id: 's', pos: [0, 90], kind: 'source' },
    { id: 'e', pos: [90, 0], kind: 'source' },
    { id: 'w', pos: [-90, 0], kind: 'source' },
  ],
  roads: [
    { id: 'r_n', from: 'j0', to: 'n', lanesPerDir: 1 },
    { id: 'r_s', from: 'j0', to: 's', lanesPerDir: 1 },
    { id: 'r_e', from: 'j0', to: 'e', lanesPerDir: 1 },
    { id: 'r_w', from: 'j0', to: 'w', lanesPerDir: 1 },
  ],
  zones: [
    { id: 'park_ne', kind: 'park', centre: [52, -54], half: [30, 26] },
    { id: 'blk_nw', kind: 'block', centre: [-50, -50], half: [30, 30] },
    { id: 'blk_sw', kind: 'block', centre: [-50, 50], half: [30, 30] },
    { id: 'blk_se', kind: 'block', centre: [50, 50], half: [30, 30] },
  ],
}
