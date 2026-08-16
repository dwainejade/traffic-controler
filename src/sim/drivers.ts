/**
 * Who is behind the wheel.
 *
 * The car-following law in `idm.ts` describes a driver; until now it described
 * the *same* driver in every vehicle on the map. One desired speed, one headway,
 * one standstill gap, no reaction time. Identical drivers platoon in lockstep,
 * discharge a queue as a block, and never produce the stop-and-go waves that a
 * real street produces at nothing more than a busy hour — those waves are an
 * emergent property of variation between drivers, so a model without variation
 * cannot show them at any demand.
 *
 * A profile is drawn once per vehicle at spawn and does not change: this is the
 * driver, not their mood.
 */
import { IDM } from "./idm";
import { VEHICLE, type VehicleKind } from "./vehicles";

export type DriverProfile = {
  /** Multiplier on the vehicle's desired free-flow speed. */
  v0Scale: number;
  /** Safe time headway, s. */
  T: number;
  /** Minimum bumper-to-bumper gap at a standstill, m. */
  s0: number;
  /** Multipliers on the vehicle's acceleration and comfortable braking. */
  aScale: number;
  bScale: number;
  /** Time constant of this driver's response to a change ahead, s. See below. */
  reaction: number;
  /** Multiplier on the critical gap accepted for a permissive left turn. */
  gapScale: number;
  /**
   * How much this driver weighs the inconvenience they cause by changing lane,
   * against their own gain. 0 considers nobody; 1 weighs others exactly as
   * themselves. See `laneChange.ts`.
   */
  politeness: number;
};

/**
 * How much drivers differ from one another.
 *
 * A single knob over every field below, so the whole feature can be switched
 * off. **Set this to 0 and every driver is exactly the `IDM` constants again**,
 * which is the only way to tell a throughput regression caused by heterogeneity
 * apart from one caused by a bug in how the profile is wired through.
 */
export const DRIVER_SPREAD = 1;

/**
 * Mean reaction lag, s. Its own constant rather than a field of the spread,
 * because it is a shift of the average driver rather than a spread around one:
 * at `DRIVER_SPREAD = 0` everybody still reacts late, just identically. Zero
 * here restores the perfect controller.
 *
 * Around 0.3s is the usual figure for an alert driver already tracking the car
 * in front — not the 1.5s of a genuine surprise, which is a braking-distance
 * number and would be far too long as a continuous following lag.
 */
export const REACTION_MEAN = 0.3;

/**
 * Mean politeness. Its own constant for the same reason `REACTION_MEAN` is: it
 * shifts the average driver rather than spreading around one, so at
 * `DRIVER_SPREAD = 0` everybody is equally considerate rather than nobody being
 * considerate at all.
 *
 * A little under a half. The literature's usual figure for ordinary motorway
 * traffic, and it reads correctly on a city street: most drivers will not force
 * a gap, and a noticeable minority will.
 */
export const POLITENESS_MEAN = 0.35;

/**
 * How much of each field's spread applies to this kind of vehicle.
 *
 * A bus driver on a route and a truck driver on a schedule are professionals
 * driving the same vehicle every day: they vary among themselves far less than
 * the general public does, and a bus that hangs back three car-lengths or takes
 * a junction on an optimistic gap reads as broken rather than as characterful.
 */
const KIND_SPREAD: Record<VehicleKind, number> = {
  car: 1,
  truck: 0.55,
  bus: 0.45,
};

/**
 * A standard-normal-ish draw, mean 0 and standard deviation 1.
 *
 * The sum of three uniforms rather than Box–Muller, for two reasons: it costs
 * three multiplies and no transcendentals, and it is *naturally truncated* at
 * ±3 sigma. A true normal has tails, and a tail here is a car with a two-second
 * standstill gap or a desired speed of 40mph — one of those in a hundred is
 * enough to dominate what the player sees.
 */
function bell(rand: () => number): number {
  return ((rand() + rand() + rand()) / 3 - 0.5) * 6;
}

/**
 * Draw a field: a mean, plus a deviation that is mostly this driver's general
 * disposition and partly noise particular to that field.
 *
 * The shared `aggr` term is the point. Drawing every field independently gives
 * drivers who want to do 30mph but leave a three-second gap behind the car in
 * front, which is not a person — it is six unrelated numbers. Correlating them
 * produces the two archetypes that actually exist on a street: the one who
 * closes up, accelerates hard and takes the marginal gap, and the one who does
 * none of those. The weights sum in quadrature to 1, so `sigma` still means
 * what it says.
 */
function field(
  rand: () => number,
  aggr: number,
  mean: number,
  sigma: number,
  spread: number,
  lo: number,
  hi: number,
): number {
  const deviation = sigma * (0.75 * aggr + 0.66 * bell(rand)) * spread;
  return Math.max(lo, Math.min(hi, mean + deviation));
}

/**
 * The average driver, used when `DRIVER_SPREAD` is 0 and as the centre of the
 * distribution otherwise. Every mean here is the value the model used before
 * profiles existed.
 */
export function meanDriver(): DriverProfile {
  return {
    v0Scale: 1,
    T: IDM.T,
    s0: IDM.s0,
    aScale: 1,
    bScale: 1,
    reaction: REACTION_MEAN,
    gapScale: 1,
    politeness: POLITENESS_MEAN,
  };
}

/**
 * @param rand the world's seeded RNG — never `Math.random`, or replays diverge
 * @param kind what they are driving, which sets how much they vary
 */
export function sampleDriver(
  rand: () => number,
  kind: VehicleKind,
): DriverProfile {
  const spread = DRIVER_SPREAD * KIND_SPREAD[kind];
  if (spread === 0) return meanDriver();

  /**
   * This driver's disposition, from timid (negative) to pushy (positive). Drawn
   * once and shared by every field below.
   */
  const aggr = bell(rand);

  return {
    v0Scale: field(rand, aggr, 1, 0.08, spread, 0.75, 1.3),
    // Sign flipped: a pushy driver follows *closer*, not further back.
    T: field(rand, -aggr, IDM.T, 0.25, spread, 0.6, 2.4),
    s0: field(rand, -aggr, IDM.s0, 0.5, spread, 1.2, 4),
    aScale: field(rand, aggr, 1, 0.15, spread, 0.6, 1.5),
    // Braking varies least: it is limited by the tyres more than by the
    // temperament. It follows the disposition rather than opposing it, because
    // a driver who follows closely but brakes gently is not a timid driver,
    // it is a rear-end collision.
    bScale: field(rand, aggr, 1, 0.1, spread, 0.7, 1.4),
    reaction: field(rand, -aggr, REACTION_MEAN, 0.08, spread, 0.05, 0.6),
    // Likewise flipped: pushy means accepting a *smaller* gap to turn across.
    gapScale: field(rand, -aggr, 1, 0.15, spread, 0.7, 1.5),
    // And flipped again: the pushy driver is the one who dives into the gap
    // without much thought for whoever has to lift off behind them.
    politeness: field(rand, -aggr, POLITENESS_MEAN, 0.14, spread, 0, 0.9),
  };
}

/**
 * The concrete numbers this driver in this vehicle hands to the IDM, resolved
 * once at spawn so the hot loop neither allocates nor multiplies them out
 * eighty times a second per car.
 */
export function resolvePower(kind: VehicleKind, driver: DriverProfile) {
  const spec = VEHICLE[kind];
  return {
    a: spec.accel * driver.aScale,
    b: spec.decel * driver.bScale,
    T: driver.T,
    s0: driver.s0,
  };
}
