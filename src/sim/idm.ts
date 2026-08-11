/**
 * Intelligent Driver Model (Treiber et al.) — the car-following law that gives
 * every vehicle its acceleration from the gap to whatever is in front of it.
 *
 * A red light is fed in as a *virtual stationary leader* parked at the stop
 * line, so queueing behind a car and queueing behind a signal run through
 * exactly the same code path.
 */
export const IDM = {
  /**
   * Desired free-flow speed, m/s.
   *
   * 11.2 m/s is 25 mph, which has been the default speed limit on every New
   * York City street without a posted sign since 2014. It is not a cosmetic
   * number: it feeds the amber and all-red formulas below, and a slower design
   * speed means shorter clearance intervals and therefore more usable green in
   * every cycle.
   */
  v0: 11.2,
  /** Safe time headway, s. */
  T: 1.3,
  /**
   * Maximum acceleration, m/s^2. Above a real car's comfortable figure on
   * purpose: start-up lost time at the head of a queue is the single biggest
   * drag on junction capacity, and a sluggish pull-away makes the whole game
   * feel unresponsive to the player's phase calls.
   */
  a: 2.2,
  /** Comfortable deceleration, m/s^2. */
  b: 2.2,
  /** Minimum bumper-to-bumper gap at a standstill, m. */
  s0: 2.2,
  /** Free-acceleration exponent. */
  delta: 4,
} as const;

/** Hard ceiling on braking, used when a gap has already been violated. */
const MAX_BRAKE = -9;

/**
 * How hard a particular vehicle accelerates and brakes.
 *
 * A loaded box truck does not pull away like a hatchback, and with mixed traffic
 * that difference is the whole point of having trucks at all: one of them at the
 * head of a queue costs the junction real capacity. Absent, the car figures
 * above are used, so every existing call site is unchanged.
 */
export type DrivePower = { a: number; b: number };

/**
 * @param v       this car's speed
 * @param gap     clear distance to the leader's rear bumper (may be negative)
 * @param leaderV leader's speed; 0 for a stop line
 * @param v0      desired speed, overridable for slow movements like tight turns
 * @param power   acceleration and braking for this vehicle; defaults to a car's
 */
export function idmAccel(
  v: number,
  gap: number,
  leaderV: number,
  v0: number = IDM.v0,
  power: DrivePower = IDM,
): number {
  const free = 1 - Math.pow(v / v0, IDM.delta);

  if (gap === Infinity) return power.a * free;
  if (gap <= 0.05) return MAX_BRAKE;

  const dv = v - leaderV;
  const sStar =
    IDM.s0 +
    Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(power.a * power.b)));

  const accel = power.a * (free - (sStar / gap) * (sStar / gap));
  return Math.max(accel, MAX_BRAKE);
}
