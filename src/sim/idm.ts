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

/**
 * Hard ceiling on braking, used when a gap has already been violated.
 *
 * Exported because the reaction lag in `world.ts` must recognise a genuine
 * emergency and skip itself: lagging a stamp on the brakes is how a following
 * model that is otherwise sound produces pileups.
 */
export const MAX_BRAKE = -9;

/**
 * How this vehicle and this driver follow the one in front.
 *
 * `a`/`b` are the vehicle: a loaded box truck does not pull away like a
 * hatchback, and with mixed traffic that difference is the whole point of having
 * trucks at all — one of them at the head of a queue costs the junction real
 * capacity. `T`/`s0` are the driver: how close they sit behind somebody moving,
 * and how close they stop behind somebody stationary. See `drivers.ts`.
 *
 * All four default to the figures above, so every existing call site is
 * unchanged.
 */
export type DrivePower = { a: number; b: number; T?: number; s0?: number };

/**
 * Seconds for a vehicle now doing `v` to cover `distance`, accelerating at `a`
 * up to `v0` and holding it.
 *
 * Exists for gap acceptance. "When will that oncoming car get here" cannot be
 * answered with `distance / v`, because the case that matters most is the one
 * where `v` is zero: a car at the head of its own queue on a fresh green is
 * doing nothing at all and is about to do 25mph, and dividing by its present
 * speed says it will never arrive. The previous answer was to floor the speed
 * at three quarters of free flow, which fixed that case by breaking the
 * opposite one — a genuinely stationary queue was scored as bearing down at
 * 8.4 m/s, and left turns yielded to traffic that was not moving.
 *
 * Integrating the launch is simply the correct answer to both.
 */
export function timeToCover(
  distance: number,
  v: number,
  a: number,
  v0: number,
): number {
  if (distance <= 0) return 0;
  if (a <= 0) return v > 0 ? distance / v : Infinity;

  // Distance it would take to wind up to its desired speed from here.
  const toTopSpeed = v < v0 ? (v0 * v0 - v * v) / (2 * a) : 0;

  // Still accelerating when it arrives: solve d = v·t + a·t²/2 for t.
  if (toTopSpeed >= distance) {
    return (Math.sqrt(v * v + 2 * a * distance) - v) / a;
  }

  // Winds up, then runs the remainder at its desired speed.
  return (v0 - v) / a + (distance - toTopSpeed) / v0;
}

/**
 * @param v       this car's speed
 * @param gap     clear distance to the leader's rear bumper (may be negative)
 * @param leaderV leader's speed; 0 for a stop line
 * @param v0      desired speed, overridable for slow movements like tight turns
 * @param power   how this vehicle and driver follow; defaults to a car's
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

  const s0 = power.s0 ?? IDM.s0;
  const T = power.T ?? IDM.T;

  const dv = v - leaderV;
  const sStar =
    s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(power.a * power.b)));

  const accel = power.a * (free - (sStar / gap) * (sStar / gap));
  return Math.max(accel, MAX_BRAKE);
}
