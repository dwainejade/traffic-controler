/**
 * What is on the road, and how big it is.
 *
 * Its own module rather than part of `world.ts` because the parking model needs
 * a car's length to space a kerb, and the world needs the parking model — one of
 * those two has to not import the other.
 */

import { IDM } from "./idm";
import { MTA_BLUE } from "../art/palette";

/**
 * What kind of vehicle a car is.
 *
 * Until now there was exactly one, and its dimensions were module constants. The
 * street only reads as a street once the traffic is mixed: a bus and a box truck
 * are three times a car's length, pull away far more slowly, and the queue that
 * forms behind one is the most legible thing on the map.
 */
export type VehicleKind = "car" | "truck" | "bus";

export type VehicleSpec = {
  /** Metres, bumper to bumper. Sets the following gap and the drawn box. */
  length: number;
  width: number;
  height: number;
  /** Desired free-flow speed, m/s. */
  v0: number;
  /** Maximum acceleration and comfortable braking, m/s^2. */
  accel: number;
  decel: number;
  /**
   * `palette` draws from the weighted fleet distribution; a hex string is a
   * livery, which is what makes a bus a bus at a glance.
   */
  colour: "palette" | string;
};

export const VEHICLE: Record<VehicleKind, VehicleSpec> = {
  car: {
    length: 4.4,
    width: 1.9,
    height: 1.4,
    v0: IDM.v0,
    accel: IDM.a,
    decel: IDM.b,
    colour: "palette",
  },
  /**
   * A two-axle box truck — the delivery lorry that actually uses a city truck
   * route, not an articulated tractor-trailer, which could not turn inside these
   * junction boxes.
   */
  truck: {
    length: 9.0,
    width: 2.5,
    height: 3.2,
    v0: 9.5,
    accel: 1.2,
    decel: 1.8,
    colour: "palette",
  },
  /** A 40-foot New Flyer, which is what runs the B44 and B49. */
  bus: {
    length: 12.2,
    width: 2.6,
    height: 3.2,
    v0: 10.0,
    accel: 1.1,
    decel: 1.9,
    colour: MTA_BLUE,
  },
};

/**
 * A car's dimensions, kept as named exports because they are the reference the
 * rest of the model is scaled against — junction sizing, spawn clearance and
 * conflict radii all reason in car-lengths.
 */
export const CAR_LENGTH = VEHICLE.car.length;
export const CAR_WIDTH = VEHICLE.car.width;

/**
 * Half-extent used when testing whether a vehicle occupies a conflict point. It
 * blocks the point when its centre is within roughly half its own length plus
 * half the crossing vehicle's width — approximated with its own width, since the
 * crossing vehicle is not known at this point and the two are within a metre.
 *
 * This is per-vehicle rather than a constant because a bus is three car-lengths
 * long: treating it as a car would have it clear a conflict point while eight
 * metres of it were still sitting on top of the crossing path.
 */
export function conflictRadius(kind: VehicleKind): number {
  const spec = VEHICLE[kind];
  return (spec.length + spec.width) / 2;
}
