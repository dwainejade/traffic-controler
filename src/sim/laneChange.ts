/**
 * When a driver pulls out into the next lane.
 *
 * MOBIL (Kesting, Treiber & Helbing) — the standard companion to the IDM in
 * `idm.ts`, and chosen for that reason: it asks the following model already here
 * what a driver's acceleration *would be* in the other lane, so there is no
 * second behaviour model to keep consistent with the first.
 *
 * The decision is two tests. Safety asks whether the car being cut in front of
 * would have to brake harder than anyone should ever be made to. Incentive asks
 * whether the gain to the driver changing outweighs the cost to everybody else,
 * discounted by how much this particular driver cares — which is where
 * `DriverProfile.politeness` earns its place, and why a pushy driver dives into
 * a gap a patient one leaves alone.
 */
import { idmAccel, type DrivePower } from "./idm";

/**
 * The most a driver may impose on the car behind them in the target lane,
 * m/s^2. A hard figure, not a comfortable one: this is the deceleration a
 * driver being cut up will accept, not one they will enjoy.
 *
 * It is the safety criterion in full — MOBIL has no other. Set it too loose and
 * cars materialise into gaps that do not exist; too tight and nobody ever
 * changes lane on a busy road, which is the failure that looks like the feature
 * simply not working.
 *
 * Measured, this one barely binds: sweeping it from 4 down to 2 changed nothing
 * at all, because a driver who has cleared the incentive test has almost always
 * found a gap that satisfies this one too. Left at the literature figure rather
 * than tightened to look busy — it is the backstop, and a backstop that rarely
 * fires is a backstop doing its job.
 */
export const B_SAFE = 4;

/**
 * Whether drivers change lane at all.
 *
 * An explicit off switch, kept for the same reason `DRIVER_SPREAD` has one: it
 * is the only way to attribute a change in throughput on a multi-lane map to
 * this model rather than to anything else that moved. On a single-lane map it
 * makes no difference either way — there is nowhere to go.
 */
export const LANE_CHANGES = true;

/**
 * How much better the new lane has to be before it is worth moving, m/s^2.
 *
 * Without a threshold every infinitesimal advantage triggers a change and the
 * road becomes a zip of cars swapping places. This is the "don't bother" band.
 *
 * Deliberately larger than `KEEP_RIGHT` below. If the bias alone cleared this
 * bar, a driver would move to the kerbside lane for no reason whatever, and
 * then back out again the moment anything slow appeared — measured, that
 * tripled the change rate without improving anything.
 */
export const THRESHOLD = 0.5;

/**
 * A driver who has just changed lane will not change again for this long, s.
 *
 * Hysteresis, and not optional. Two lanes of near-equal incentive otherwise
 * produce cars oscillating between them indefinitely — the classic MOBIL
 * failure, which shows up as neither a crash nor a throughput loss, only as
 * traffic that looks demented.
 */
export const CHANGE_COOLDOWN = 6;

/**
 * Standing preference for the kerbside lane, m/s^2 of pretend incentive.
 *
 * Keep right except to pass — the rule of the road here, and without it the
 * model is measurably worse than no lane changing at all. Symmetric MOBIL lets
 * a car going straight on drift into whichever lane is momentarily emptier, and
 * at a junction the innermost lane is the only one a left turn leaves from. So
 * through traffic settles into the left-turn lane, queues behind somebody
 * waiting for a gap in the oncoming, and blocks an approach that was never
 * congested. Measured, that cost six seconds of delay per car at free flow.
 *
 * Applied as a bias on the incentive rather than as a rule, so it is a
 * preference a driver will override for a good enough reason — which is exactly
 * what overtaking is.
 */
export const KEEP_RIGHT = 0.2;

/** One participant in the decision, reduced to what the IDM needs. */
export type Follower = {
  v: number;
  /** Clear distance to the leader's rear bumper, m. Infinity for no leader. */
  gap: number;
  /** Leader's speed; irrelevant when `gap` is Infinity. */
  leaderV: number;
  v0: number;
  power: DrivePower;
};

function accelOf(f: Follower): number {
  return idmAccel(f.v, f.gap, f.leaderV, f.v0, f.power);
}

export type ChangeCase = {
  /** The driver considering the move, as they are now and as they would be. */
  selfBefore: Follower;
  selfAfter: Follower;
  /**
   * The car that would end up behind them in the target lane, before and after.
   * `null` when the target lane is clear behind — the common case, and the one
   * where the safety test is trivially satisfied.
   */
  targetFollowerBefore: Follower | null;
  targetFollowerAfter: Follower | null;
  /**
   * The car left behind in the lane being vacated. It can only gain, so it
   * never blocks the change — but a polite driver counts that gain, which is
   * what makes them pull over out of somebody's way rather than only ever
   * pulling out for their own benefit.
   */
  sourceFollowerBefore: Follower | null;
  sourceFollowerAfter: Follower | null;
};

/**
 * @param politeness 0 = considers nobody, 1 = weighs others exactly as self
 * @param side       -1 toward the centreline, +1 toward the kerb
 * @returns whether the change is both safe and worth making
 */
export function mobilAccepts(
  c: ChangeCase,
  politeness: number,
  side: -1 | 1,
): boolean {
  // --- Safety. Checked first and on its own: no amount of incentive, and no
  // degree of impatience, buys a driver the right to force this.
  const targetAfter =
    c.targetFollowerAfter !== null ? accelOf(c.targetFollowerAfter) : 0;
  if (targetAfter < -B_SAFE) return false;

  // --- Incentive. Moving toward the kerb is rewarded, moving away is charged
  // for, so a driver returns to the outer lane once the reason to leave it has
  // gone rather than staying wherever the last overtake left them.
  const gain = accelOf(c.selfAfter) - accelOf(c.selfBefore) + side * KEEP_RIGHT;

  const targetBefore =
    c.targetFollowerBefore !== null ? accelOf(c.targetFollowerBefore) : 0;
  const sourceBefore =
    c.sourceFollowerBefore !== null ? accelOf(c.sourceFollowerBefore) : 0;
  const sourceAfter =
    c.sourceFollowerAfter !== null ? accelOf(c.sourceFollowerAfter) : 0;

  // Positive when the move costs the others something, negative when it helps
  // them — the car left behind in the vacated lane is normally the second case.
  const costToOthers =
    targetBefore - targetAfter + (sourceBefore - sourceAfter);

  return gain > THRESHOLD + politeness * costToOthers;
}
