import type { LevelDef } from "../sim/types";

/**
 * Dev-only proving ground for curved-road geometry: a plain crossroads whose
 * west arm bows hard and whose north arm carries an S-curve. Not part of the
 * shipped progression — it exists so `validateLevel` can exercise every curve
 * code path (trim, offset, arm tangents, marking walks) on a map small enough
 * to debug by hand.
 */
export const CURVE_TEST: LevelDef = {
  id: "curve-test",
  name: "Curve Test",
  half: 130,
  seed: 20260809,
  quota: 20,
  timeLimit: 180,
  demand: 0.2,
  nodes: [
    { id: "j", pos: [0, 0], kind: "junction" },
    { id: "n", pos: [10, -120], kind: "source" },
    { id: "s", pos: [0, 120], kind: "source" },
    { id: "e", pos: [120, 0], kind: "source" },
    { id: "w", pos: [-120, -20], kind: "source" },
  ],
  roads: [
    // S-curve: two opposing bows on the way north.
    { id: "rn", from: "j", to: "n", lanesPerDir: 1, waypoints: [[-14, -45], [22, -85]] },
    { id: "rs", from: "j", to: "s", lanesPerDir: 1 },
    { id: "re", from: "j", to: "e", lanesPerDir: 1 },
    // Single deep bow west.
    { id: "rw", from: "j", to: "w", lanesPerDir: 1, waypoints: [[-62, 26]] },
  ],
  zones: [],
};
