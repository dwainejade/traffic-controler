/**
 * Locked palette, sampled from the Apple Maps 3D driving reference.
 *
 * The governing rule: the environment is high-key and desaturated (<20% sat),
 * so the only saturated things on screen are cars and signals (70-90% sat).
 * Do not add saturated environment colors without removing one.
 */

export const PALETTE = {
  /** Page behind the level card. Slightly darker than the card so it reads as an object. */
  background: "#E3E0DA",

  /** Ground / sidewalk. The brightest thing on screen. */
  ground: "#F0EEEA",

  /**
   * Road surface. Deliberately darker than Apple's #7C8085 — the road network
   * is the playfield here and has to silhouette clearly against the ground.
   */
  road: "#5E6469",
  /** Curb / casing, drawn as a lip just under and around the asphalt. */
  curb: "#4E5459",
  /** Lane markings, stop lines, crosswalks. */
  marking: "#FFFFFF",

  /**
   * The kerb a median stands on. Sidewalk tone rather than road tone: a median
   * is a piece of the footway left in the middle of the street, and reading it
   * as pavement is what tells you at a glance that it is raised and not paint.
   */
  medianKerb: "#DCD8D1",

  /**
   * Bus lane paint. The second saturated thing allowed into the environment,
   * and it earns the exemption the same way it does in life: a bus lane is only
   * useful if you can see at a glance that it is not for you. Kept dusty rather
   * than the fire-engine red of fresh thermoplastic, so it sits with the rest.
   */
  busLane: "#C08276",
  /** Parking strip: paved, but a shade off the running surface. */
  parking: "#565C61",

  /**
   * Water around the island. The one place the palette's low-saturation rule
   * bends: Apple Maps' water is a genuine blue, and it is what tells you at a
   * glance that the pale shape in the middle is land. Kept light and slightly
   * grey so it still sits behind the traffic rather than competing with it.
   */
  water: "#A8CDE0",
  /** A touch deeper, for the strip right against the shore. */
  waterDeep: "#93BDD4",

  /**
   * Street name signs at the corners. Kept inside the environment's saturation
   * ceiling: a real blade is a strong green, and four of them at every junction
   * in that green would put more saturated area on the map than the traffic.
   */
  signBlade: "#3E5B4C",
  signPost: "#7C8288",

  /** Park fill. Accent only — never base terrain. */
  park: "#93C97E",
  /**
   * Grass and amenity land — verges, cemeteries, recreation ground.
   *
   * A real import puts whole blocks of this on the map, so unlike `park` it is
   * terrain and stays inside the environment's saturation ceiling. Sitting a
   * tone off the parks is what keeps a park reading as a place you would go.
   */
  grass: "#C6D2B9",
  treeFoliage: "#79B463",
  treeFoliageDark: "#689C54",
  treeTrunk: "#8B7355",

  /** Buildings: near-white, separated from the ground mostly by contact shadow. */
  buildingBase: "#DAD7D1",
  buildingTop: "#F4F2EE",

  /** Per-building tint categories, assigned at scatter time to break up the mass. */
  buildingTints: ["#E9D8D0", "#DDDEE1", "#EDE6D8", "#E4E2DD"] as const,

  accent: "#A8D8D0",
} as const;

/**
 * Real-world car colour distribution, weighted roughly as the actual global
 * fleet: about three quarters achromatic, led by white, black, grey and silver.
 *
 * Cars used to be coloured by destination, which made every vehicle's intent
 * readable at a glance — nothing like real traffic. Now you can only tell where
 * a car is going the way you can in life: which lane it picked, and whether its
 * indicator is on.
 *
 * A side effect worth knowing: with cars mostly neutral, the signals become the
 * only saturated thing on screen, which is the right emphasis for this game.
 */
export const VEHICLE_COLORS: readonly { hex: string; weight: number }[] = [
  { hex: "#EDEDEA", weight: 30 }, // white
  { hex: "#2A2C2F", weight: 15 }, // black
  { hex: "#8C9094", weight: 24 }, // grey
  { hex: "#C3C7CA", weight: 24 }, // silver
  { hex: "#2F4460", weight: 14 }, // dark blue
  { hex: "#5A6570", weight: 10 }, // gunmetal
  { hex: "#8E3038", weight: 5 }, // dark red
  { hex: "#33513C", weight: 2 }, // dark green
  { hex: "#B9A88B", weight: 8 }, // beige
  { hex: "#B5563A", weight: 2 }, // bronze

  // New additions (balanced, realistic automotive tones)
  { hex: "#4B6E8F", weight: 5 }, // steel blue
  { hex: "#7A5C4F", weight: 5 }, // mocha brown
  { hex: "#D4CFC3", weight: 10 }, // pearl sand
  { hex: "#6E2F2F", weight: 6 }, // burgundy
  { hex: "#3A3D28", weight: 6 }, // olive drab
  { hex: "#5D4E7A", weight: 5 }, // muted purple
  { hex: "#A3B8A5", weight: 6 }, // sage green
  { hex: "#D9B14C", weight: 1 }, // gold metallic
  { hex: "#7F8A9E", weight: 7 }, // slate blue-grey
];

/**
 * MTA bus blue.
 *
 * The third and last saturated thing allowed into the environment, and it earns
 * it the same way the bus lane does: a bus is the one vehicle whose identity has
 * to be readable from across the map, because it is the one vehicle whose
 * behaviour — stopping at the kerb, holding a lane no one else may use — makes
 * no sense unless you know what it is.
 */
export const MTA_BLUE = "#0039A6";

/** Window band on a bus, so it does not read as a plain blue slab. */
export const BUS_GLASS = "#B7C4D6";

/** Amber of a turn indicator. Emissive, so it reads against any body colour. */
export const INDICATOR = "#FFA318";

/** Reserved for destination markers on the map, not for vehicles. */
export const DISTRICT_COLORS = [
  "#E8503A", // coral
  "#2D8FD5", // azure
  "#F0A830", // amber
  "#8B5CF6", // violet
  "#16A394", // teal
] as const;

/** Signal colors — emissive, and the only things allowed past the bloom threshold. */
export const SIGNAL = {
  green: "#3DDB6B",
  amber: "#FFB020",
  red: "#FF4438",
} as const;
