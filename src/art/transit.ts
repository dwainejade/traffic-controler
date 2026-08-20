/**
 * Transit mode's palette.
 *
 * The signal game's rule was: the environment is desaturated so the *signals*
 * are the only saturated thing on screen. Transit mode keeps the rule and moves
 * what it protects. Here the saturated things are the bus lines, their stops,
 * the buildings people are trying to reach, and the people themselves — so the
 * traffic has to get quieter than it is in the signal game, where it was the
 * subject.
 *
 * Everything in here is additive: `PALETTE` is untouched, and with transit mode
 * off the game looks exactly as it did.
 */

/**
 * Line colours, in the order routes are handed them.
 *
 * Chosen the way a transit map chooses them — maximally separable at the width
 * of a drawn line, which is a few pixels — and pitched bright rather than deep,
 * because a line is drawn *on* the near-black road surface and a deep colour
 * disappears into it. These are the loudest things the art direction allows.
 */
export const LINE_COLORS = [
  '#F5423E', // red
  '#1B8FEC', // blue
  '#22B07D', // green
  '#F5A623', // amber
  '#9B59F5', // violet
  '#00B8C4', // cyan
  '#F55CA8', // pink
  '#7C8B00', // olive
] as const

/** A line's casing, so it reads as a drawn line and not as paint on the road. */
export const LINE_CASING = '#FFFFFF'

/**
 * Destination buildings — the places people are going.
 *
 * A shade deeper than the line colours and drawn over a whole building face
 * rather than a five-metre ribbon, which is why they cannot simply be the same
 * list: at building area, `LINE_COLORS` would out-shout the lines that lead to
 * them, and the map would read as a set of coloured blocks with grey threads
 * between.
 */
export const DESTINATION_COLORS = [
  '#D9483F',
  '#2E7CC4',
  '#2A9A72',
  '#D18A22',
  '#8351C9',
  '#0E96A1',
] as const

/**
 * Waiting pedestrians, painted the colour of the building they want.
 *
 * The whole readability of the game rests on this one pairing: a knot of coral
 * pips on a corner and a coral building four blocks away is a sentence, and it
 * is the only way to see unserved demand without a panel of numbers.
 */
export function riderColor(destination: number): string {
  return DESTINATION_COLORS[destination % DESTINATION_COLORS.length]
}

/** A rider who has waited past their patience. Desaturated, not red-alarmed. */
export const RIDER_GIVING_UP = '#8B8B8B'

/**
 * The fleet, quieted.
 *
 * `VEHICLE_COLORS` is the real-world distribution and is the right answer when
 * the cars are the subject. In transit mode they are the weather, and the real
 * distribution puts 30% pure white and a scatter of reds on screen — bright
 * enough to compete with the lines for attention. This is the same distribution
 * pulled toward the road's own grey: still a plausible street, no longer a
 * street that argues with the map drawn over it.
 */
export const MUTED_VEHICLE_COLORS: readonly { hex: string; weight: number }[] = [
  { hex: '#D8D6D2', weight: 30 }, // white, warmed and dropped off pure
  { hex: '#3A3D40', weight: 15 }, // black
  { hex: '#8A8E92', weight: 24 }, // grey
  { hex: '#B4B8BB', weight: 24 }, // silver
  { hex: '#4A5766', weight: 14 }, // dark blue
  { hex: '#666F79', weight: 10 }, // gunmetal
  { hex: '#7E5A5D', weight: 5 }, // dark red, most of the red taken out
  { hex: '#55655B', weight: 2 }, // dark green
  { hex: '#AFA697', weight: 8 }, // beige
  { hex: '#9A7F74', weight: 4 }, // bronze
  { hex: '#5F7387', weight: 5 }, // steel blue
  { hex: '#7A6A62', weight: 5 }, // mocha
  { hex: '#C7C3BB', weight: 10 }, // pearl sand
  { hex: '#7A6068', weight: 6 }, // burgundy
  { hex: '#565A4B', weight: 6 }, // olive drab
  { hex: '#6E6779', weight: 5 }, // muted purple
  { hex: '#9EA9A0', weight: 6 }, // sage
  { hex: '#8B8B93', weight: 7 }, // slate
]

/** Stop markers. Near-white so they read on the line whatever colour it is. */
export const STOP_FACE = '#FDFCFA'
export const STOP_RIM = '#2E3338'

/** The path being drawn, before it is committed. */
export const DRAFT_LINE = '#1B8FEC'
/** A junction the draft can be extended to, and the one under the cursor. */
export const DRAFT_NODE = '#FFFFFF'
export const DRAFT_NODE_HOT = '#1B8FEC'
