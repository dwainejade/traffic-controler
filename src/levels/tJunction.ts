import type { LevelDef } from "../sim/types";

const ARM = 95;

/**
 * The first level: a T-junction on a quiet street.
 *
 * The simplest junction that still needs signals. Three arms instead of four
 * means three phases instead of four, and one of those phases is nearly free —
 * with the side road on the east, southbound traffic never crosses it, so the
 * conflict-driven phase builder gives N→S a green in *every* phase. Seeing one
 * direction flow continuously while the others take turns is the clearest
 * possible introduction to what a phase actually is.
 *
 * Traffic is deliberately light: ~900 veh/h against a junction that can handle
 * far more, so nothing gridlocks while the player learns the controls.
 */
export const T_JUNCTION: LevelDef = {
  id: "t-junction",
  name: "Quiet Corner",
  half: 118,
  seed: 20260811,

  /*
   * 0.25 veh/s = 900 veh/h, ~12s mean delay — level-of-service B. Comfortable.
   * The default 3-phase program (20s each, 75s cycle) already clears this, so
   * the level is about reading the signals rather than rescuing them.
   */
  quota: 29,
  timeLimit: 150,
  demand: 0.2,

  nodes: [
    { id: "j0", pos: [0, 0], kind: "junction" },
    { id: "n", pos: [0, -ARM], kind: "source" },
    { id: "s", pos: [0, ARM], kind: "source" },
    { id: "e", pos: [ARM, 0], kind: "source" },
  ],

  roads: [
    // One lane each way throughout — a quiet street, and the layout where a
    // left-turner genuinely holds up the car behind it.
    { id: "r_n", from: "j0", to: "n", lanesPerDir: 1 },
    { id: "r_s", from: "j0", to: "s", lanesPerDir: 1 },
    { id: "r_e", from: "j0", to: "e", lanesPerDir: 1 },
  ],

  zones: [
    // No western arm, so the whole west side is uninterrupted frontage.
    { id: "park_w", kind: "park", centre: [-58, -52], half: [32, 34] },
    { id: "blk_w", kind: "block", centre: [-58, 42], half: [32, 44] },
    { id: "blk_ne", kind: "block", centre: [56, -56], half: [32, 30] },
    { id: "blk_se", kind: "block", centre: [56, 56], half: [32, 30] },
  ],
};
