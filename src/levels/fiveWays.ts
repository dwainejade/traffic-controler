import type { LevelDef, MapNode, RoadDef } from "../sim/types";

const ARM = 100;

/** Arms every 72°, so no two are opposite and nothing pairs up neatly. */
const BEARINGS: { id: string; deg: number }[] = [
  { id: "a_n", deg: 0 },
  { id: "a_e", deg: 72 },
  { id: "a_se", deg: 144 },
  { id: "a_sw", deg: 216 },
  { id: "a_w", deg: 288 },
];

const sources: MapNode[] = BEARINGS.map(({ id, deg }) => {
  const a = (deg * Math.PI) / 180;
  return {
    id,
    pos: [Math.sin(a) * ARM, -Math.cos(a) * ARM],
    kind: "source",
  };
});

const roads: RoadDef[] = BEARINGS.map(({ id }) => ({
  id: `r_${id}`,
  from: "j0",
  to: id,
  lanesPerDir: 1,
}));

/**
 * A five-arm junction, arms evenly spaced 72° apart.
 *
 * The point of this level is that **no two arms are opposite each other**. On a
 * cross, opposing through movements never conflict, so they pair up and each
 * phase serves two approaches at once. Here every pair of arms is oblique, far
 * more movements cross, and the phase builder needs seven phases rather than
 * four to cover them all.
 *
 * That is the lesson: phases are not free. Seven phases cost seven clearance
 * intervals — 35 seconds a cycle spent serving nobody — so this junction has
 * markedly less capacity than a four-arm cross despite having more roads.
 * Traffic is set low to match.
 */
export const FIVE_WAYS: LevelDef = {
  id: "five-ways",
  name: "Five Ways",
  half: 124,
  seed: 20260812,

  quota: 23,
  timeLimit: 180,
  demand: 0.16,

  nodes: [{ id: "j0", pos: [0, 0], kind: "junction" }, ...sources],
  roads,

  zones: [
    // Wedges of frontage between the arms.
    { id: "blk_n", kind: "block", centre: [-46, -62], half: [26, 26] },
    { id: "park_ne", kind: "park", centre: [58, -46], half: [26, 26] },
    { id: "blk_e", kind: "block", centre: [72, 40], half: [24, 24] },
    { id: "blk_s", kind: "block", centre: [-4, 82], half: [26, 22] },
    { id: "blk_w", kind: "block", centre: [-74, 30], half: [24, 26] },
  ],
};
