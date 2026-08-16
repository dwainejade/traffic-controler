import type { LevelDef } from "../sim/types";

/**
 * The lane-changing proving ground. A dev-only level, like `curveTest`.
 *
 * Two lanes each way on a straight east–west arterial, crossed by an ordinary
 * single-lane street. Everything about it is chosen to isolate the lane-change
 * model from everything else that could explain a change in the numbers:
 *
 *  - **Straight roads, no waypoints.** Sibling lanes then have exactly equal
 *    arc length, so the proportional `s` mapping a change performs is the
 *    identity and any discrepancy is a bug rather than the `d·theta` an offset
 *    curve legitimately carries.
 *  - **The arterial is `primary`.** That is what puts trucks on it — they are
 *    confined to `TRUCK_ROUTE` classes — and a truck doing 9.5 m/s in a lane of
 *    cars wanting 11.2 is the whole reason to overtake. Without one, two lanes
 *    of identical traffic give the model nothing to decide.
 *  - **The cross street is unclassified and single-lane**, so it stays out of
 *    the way: it exists to make the junction signalised, which is what produces
 *    the platoons that make overtaking worth watching.
 *
 * Turning movements are bound to lanes when the network is built — left only
 * from the lane nearest the centreline, right only from the one nearest the
 * kerb — so a car's route already determines which lane it can be in at the
 * junction. Until routing learns about lane changes, the entry-lane choice at
 * spawn is what satisfies that, and a car will refuse any change that would
 * leave it with no route.
 */
const ARM = 120;

export const LANE_TEST: LevelDef = {
  id: "lane-test",
  name: "Lane Test",
  half: 140,
  seed: 20260816,
  sandbox: true,
  quota: 0,
  timeLimit: 0,
  /*
   * Well above what one junction can clear, deliberately. Lane changing only
   * has anything to say when the lanes differ from one another, and that needs
   * enough traffic for a slow vehicle to gather a queue behind it.
   */
  demand: 0.5,
  warmupSeconds: 45,
  nodes: [
    { id: "j", pos: [0, 0], kind: "junction" },
    { id: "w", pos: [-ARM, 0], kind: "source" },
    { id: "e", pos: [ARM, 0], kind: "source" },
    { id: "n", pos: [0, -ARM], kind: "source" },
    { id: "s", pos: [0, ARM], kind: "source" },
  ],
  roads: [
    {
      id: "r_w",
      from: "j",
      to: "w",
      lanesPerDir: 2,
      class: "primary",
      name: "Broad Avenue",
    },
    {
      id: "r_e",
      from: "j",
      to: "e",
      lanesPerDir: 2,
      class: "primary",
      name: "Broad Avenue",
    },
    { id: "r_n", from: "j", to: "n", lanesPerDir: 1, name: "Cross Street" },
    { id: "r_s", from: "j", to: "s", lanesPerDir: 1, name: "Cross Street" },
  ],
  zones: [
    { id: "blk_nw", kind: "block", centre: [-70, -60], half: [40, 34] },
    { id: "blk_ne", kind: "block", centre: [70, -60], half: [40, 34] },
    { id: "blk_sw", kind: "block", centre: [-70, 60], half: [40, 34] },
    { id: "blk_se", kind: "block", centre: [70, 60], half: [40, 34] },
  ],
};
