/**
 * Kerbside parking.
 *
 * `parkingSides` has been on `RoadDef` since the OSM import landed, and until
 * now it did exactly one thing: widen the paved surface and move the kerb out.
 * That was the honest half of the model — the strip is real width, and the
 * street is genuinely that wide — but an empty parking strip is the single most
 * conspicuously wrong thing about a Brooklyn street. In life the kerb is parked
 * solid, and the gaps in it are what a driver is actually looking at.
 *
 * Slots are laid out on the same trimmed centreline the lanes are built from and
 * at the same lateral offsets `roadEdges` paints, so a parked car always sits
 * exactly on the paint rather than somewhere close to it.
 */

import {
  roadCentreline,
  polyLength,
  samplePoly,
  trimPoly,
  type Pt,
} from "./centreline";
import { laneLateralOffset, type LaneId, type Network } from "./network";
import {
  PARKING_WIDTH,
  STOP_OFFSET,
  junctionSize,
  nodeById,
  roadEdges,
  type LevelDef,
  type NodeId,
  type RoadDef,
} from "./types";
import { CAR_LENGTH, VEHICLE } from "./vehicles";
import { mulberry32 } from "../render/geometry";

/** Which kerb, relative to the road's own from→to direction. */
export type ParkingSide = "left" | "right";

export type ParkingSlot = {
  id: number;
  roadId: string;
  side: ParkingSide;
  /** Arc distance along the road's *trimmed* centreline. */
  s: number;
  /** Signed lateral offset from the centreline, positive right of from→to. */
  lateral: number;
  /** Cached world pose, so the renderer never re-walks the geometry. */
  x: number;
  z: number;
  angle: number;
  /**
   * Which car is in it. `null` is an empty bay; a car id is a vehicle the
   * simulation parked there and can take out again.
   */
  occupant: number | null;
  /** Index into the fleet palette, fixed at layout time so a bay never reflows. */
  colour: number;
  /** Fraction along the trimmed centreline, used to find the same point on a lane. */
  t: number;

  // --- Filled in by `bindParking`, once the lane graph exists.

  /** The driving lane a car uses to reach or leave this bay. */
  laneId: LaneId;
  /** Where along that lane the bay sits. */
  laneS: number;
  /**
   * How far right of that lane's centreline the bay is — negative when the bay
   * is on the driver's left, which is what the far kerb of a one-way street is.
   */
  laneLateral: number;
};

/**
 * Centre-to-centre bay spacing. A car plus the room to get out of the space,
 * which is what sets the real figure — kerbside bays are marked at about 6m for
 * a car under 4.5m long precisely so the manoeuvre is possible.
 */
const SLOT_PITCH = CAR_LENGTH + 1.4;

/**
 * Kerb left clear at each end of a road, past the junction box.
 *
 * The box itself is already excluded by trimming, but that is not nearly
 * enough, for two reasons that happen to want the same number.
 *
 * The painted one: the stop line sits `STOP_OFFSET` out from the box with the
 * crosswalk between them, so anything closer than that is a bay drawn on top of
 * a crossing. New York then keeps a further twenty feet clear at the corner —
 * "daylighting" — so drivers can see who is stepping off it.
 *
 * The moving one, which is what actually made this matter: a car stopping to
 * park is a stationary obstacle in the running lane, and one that stops a few
 * metres past a junction exit backs the queue up *into the box*. Cars stranded
 * in the box when the phase changes are precisely how this simulation produces
 * collisions, and bays too near the corner measurably raised the crash rate on
 * every seed until this figure was right.
 */
const END_CLEARANCE = STOP_OFFSET + 6;

/**
 * Kerb kept clear either side of a bus stop.
 *
 * A 40-foot bus needs to get its doors to the kerb, which means rather more
 * than its own length of clear space to pull in and out of. This is the whole
 * reason the parking model has to know about stops at all.
 */
export const BUS_STOP_CLEARANCE = 25;

/**
 * How full the kerb is.
 *
 * Not 100%: the gaps are the point. A solid wall of parked cars has nowhere for
 * anyone to pull into and nothing ever changes, and it also reads as scenery
 * rather than as traffic. Brooklyn's alternate-side parking keeps the real
 * figure somewhere near this.
 */
const OCCUPANCY = 0.86;

/**
 * A place a bus pulls in, insofar as the parking layout has to avoid one.
 * Carried as a fraction rather than a distance so it can be measured on the bus
 * lane and applied to the kerb, which are different lengths.
 */
export type StopMark = { roadId: string; t: number };

export type ParkingLayout = {
  slots: ParkingSlot[];
  /** Slot ids on each road, so a car looking for a space has a short list. */
  byRoad: Map<string, number[]>;
  /**
   * Bumped whenever a bay changes hands.
   *
   * The renderer holds a thousand-odd transforms that are almost always
   * identical from frame to frame, and rewriting them sixty times a second to
   * catch the two that changed would cost more than the moving traffic does.
   * This is the cheap "has anything happened" test that avoids it.
   */
  revision: number;
};

/**
 * Lay out every kerbside bay on the map.
 *
 * `stops` is consulted only to keep their kerb clear; it is empty until bus
 * stops exist, at which point the layout re-runs and the bays near them vanish.
 */
export function buildParking(
  level: LevelDef,
  stops: StopMark[] = [],
): ParkingLayout {
  const rand = mulberry32(level.seed ^ 0x5eed);
  const slots: ParkingSlot[] = [];
  const byRoad = new Map<string, number[]>();

  const stopsByRoad = new Map<string, number[]>();
  for (const stop of stops) {
    const list = stopsByRoad.get(stop.roadId) ?? [];
    list.push(stop.t);
    stopsByRoad.set(stop.roadId, list);
  }

  for (const road of level.roads) {
    const sides = road.parkingSides ?? 0;
    if (sides < 1) continue;

    const poly = trimmedCentreline(level, road);
    const total = polyLength(poly);
    const usable = total - END_CLEARANCE * 2;
    if (usable < SLOT_PITCH) continue;

    const edges = roadEdges(road);
    const near = stopsByRoad.get(road.id) ?? [];

    // Centre the run of bays in the usable length, so a street does not end
    // with one conspicuously large gap at the far kerb.
    const count = Math.floor(usable / SLOT_PITCH);
    const slack = (usable - count * SLOT_PITCH) / 2;

    const ids: number[] = [];
    for (const side of ["right", "left"] as const) {
      if (side === "left" && sides < 2) continue;

      // Outboard of everything else on that side, hard against the kerb.
      const lateral =
        side === "right"
          ? edges.right - PARKING_WIDTH / 2
          : edges.left + PARKING_WIDTH / 2;

      for (let i = 0; i < count; i++) {
        const s = END_CLEARANCE + slack + (i + 0.5) * SLOT_PITCH;
        // The stop's position arrives as a fraction of the bus lane; scaled by
        // this kerb's own length it lands on the same piece of street.
        if (near.some((t) => Math.abs(t * total - s) < BUS_STOP_CLEARANCE)) continue;

        const p = samplePoly(poly, s);
        /*
         * A parked car faces the way the traffic beside it moves. On a two-way
         * street the left kerb is served by the reverse direction, so it faces
         * the other way; on a one-way both kerbs face the single direction, and
         * a car pointing backwards there would look parked the wrong way round —
         * which, in New York, it would be.
         */
        const flip = side === "left" && !road.oneWay;
        const angle = Math.atan2(p.tx, p.tz) + (flip ? Math.PI : 0);

        // Lateral to the driver's right of from→to is (-tz, +tx), matching the
        // road markings in the renderer.
        const id = slots.length;
        slots.push({
          id,
          roadId: road.id,
          side,
          s,
          lateral,
          x: p.x - p.tz * lateral,
          z: p.z + p.tx * lateral,
          angle,
          occupant: rand() < OCCUPANCY ? -1 : null,
          colour: Math.floor(rand() * 1024),
          t: s / total,
          laneId: -1,
          laneS: 0,
          laneLateral: 0,
        });
        ids.push(id);
      }
    }

    byRoad.set(road.id, ids);
  }

  return { slots, byRoad, revision: 0 };
}

/**
 * The stretch of a road that is actually street rather than junction — the same
 * polyline `buildNetwork` builds its lanes on, so bays and lanes agree about
 * where the road begins.
 */
function trimmedCentreline(level: LevelDef, road: RoadDef): Pt[] {
  const halfOf = (id: NodeId) =>
    nodeById(level, id).kind === "junction" ? junctionSize(level, id) / 2 : 0;
  return trimPoly(
    roadCentreline(level, road),
    halfOf(road.from),
    halfOf(road.to),
  );
}

/**
 * Attach every bay to the lane a driver would use to reach it.
 *
 * Separate from `buildParking` because the lane graph is built from the same
 * level and neither can depend on the other; the world owns both and joins them.
 *
 * The lane is chosen by proximity rather than by rule. A right-hand kerb on a
 * two-way street is served by the forward carriageway's outermost lane, a
 * left-hand kerb by the backward one's — but the far kerb of a *one-way* street
 * has no opposing carriageway at all, and is served from the driver's left by
 * the innermost lane of the only direction there is. Picking the nearest lane
 * gets all three without enumerating them.
 */
export function bindParking(
  level: LevelDef,
  net: Network,
  layout: ParkingLayout,
): void {
  const roads = new Map(level.roads.map((r) => [r.id, r]));

  for (const slot of layout.slots) {
    const road = roads.get(slot.roadId)!;

    let best: { id: LaneId; lateral: number; forward: boolean } | null = null;

    for (const lane of net.lanes) {
      if (lane.roadId !== road.id || lane.kind !== "road") continue;
      const forward = lane.fromNode === road.from;
      const off = laneLateralOffset(road, lane.index);
      /*
       * `slot.lateral` is measured right of the road's own from→to direction;
       * a car's is measured right of *its* direction of travel. For a lane
       * running against the road those two frames are mirrored, hence the sign.
       */
      const lateral = forward ? slot.lateral - off : -(slot.lateral + off);
      if (best === null || Math.abs(lateral) < Math.abs(best.lateral)) {
        best = { id: lane.id, lateral, forward };
      }
    }

    if (best === null) continue;
    const lane = net.lanes[best.id];
    slot.laneId = best.id;
    slot.laneLateral = best.lateral;
    // Offsetting a curve changes its length slightly, so map by fraction rather
    // than by absolute distance; on a reversed lane the fraction runs backwards.
    slot.laneS = (best.forward ? slot.t : 1 - slot.t) * lane.length;
  }
}

// -------------------------------------------------------------- bus stops

export type BusStop = {
  id: number;
  /** The bus lane this stop is on, and where along it a bus pulls up. */
  laneId: LaneId;
  laneS: number;
  /** The road and the fraction along it, so the kerb beside it can be cleared. */
  roadId: string;
  t: number;
  /** Seconds this stop holds a bus. */
  dwell: number;
  /** World pose, for the paint. */
  x: number;
  z: number;
  angle: number;
};

const BUS_LENGTH = VEHICLE.bus.length;

/**
 * Metres past the junction box a far-side stop sits.
 *
 * Far enough that the painted box clears the crosswalk behind it: the stop is
 * measured to the centre of a bus, so half a bus plus the crossing is the floor.
 */
const FAR_SIDE_OFFSET = STOP_OFFSET + BUS_LENGTH / 2 + 2;

/** Shortest gap between consecutive stops on one corridor. */
const MIN_STOP_SPACING = 150;

/** Seconds a bus holds while people get on and off. */
const DWELL_MIN = 12;
const DWELL_MAX = 20;

/**
 * Place the stops.
 *
 * **Far side**, meaning just after the junction rather than just before it. That
 * is not a stylistic choice: a near-side stop puts a dwelling bus across the
 * stop line for fifteen seconds at a time, so it blocks its own approach and
 * every phase it is not being served by. Far-side stops are the standard for
 * exactly this reason, and the difference is visible the moment the bus lane has
 * signals on it.
 *
 * Synthesised rather than surveyed. OSM does carry `highway=bus_stop` nodes, but
 * fetching them would mean regenerating the committed extract; one stop per
 * junction with a spacing floor puts them within a block of the real ones, which
 * is as much accuracy as anything here depends on.
 */
export function buildBusStops(level: LevelDef, net: Network): BusStop[] {
  const stops: BusStop[] = [];
  const roads = new Map(level.roads.map((r) => [r.id, r]));
  const rand = mulberry32(level.seed ^ 0xb005);

  // Corridors run through several road segments, so spacing is enforced against
  // stops already placed anywhere nearby rather than per segment.
  const placed: { x: number; z: number }[] = [];

  for (const lane of net.lanes) {
    if (lane.kind !== "road" || lane.access !== "bus" || lane.roadId === null) continue;

    const road = roads.get(lane.roadId);
    if (!road) continue;

    // Only where the bus has just come through a junction — the far side of it.
    const from = nodeById(level, lane.fromNode!);
    if (from.kind !== "junction") continue;

    const at = FAR_SIDE_OFFSET;
    // No room to stop and still clear the far end.
    if (lane.length < at + 40) continue;

    const p = samplePoly(laneToPoly(lane), at);
    if (placed.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < MIN_STOP_SPACING)) continue;

    stops.push({
      id: stops.length,
      laneId: lane.id,
      laneS: at,
      roadId: road.id,
      // Bus lanes on a one-way run with the road; on a two-way the backward
      // lane runs against it, so the fraction has to be flipped to land on the
      // same piece of kerb the parking model measures.
      t: lane.fromNode === road.from ? at / lane.length : 1 - at / lane.length,
      dwell: DWELL_MIN + rand() * (DWELL_MAX - DWELL_MIN),
      x: p.x,
      z: p.z,
      angle: Math.atan2(p.tx, p.tz),
    });
    placed.push({ x: p.x, z: p.z });
  }

  return stops;
}

/** A lane's flattened point pairs, back as a polyline the samplers understand. */
function laneToPoly(lane: Network["lanes"][number]): Pt[] {
  const poly: Pt[] = [];
  for (let i = 0; i < lane.pts.length; i += 2) {
    poly.push({ x: lane.pts[i], z: lane.pts[i + 1] });
  }
  return poly;
}
