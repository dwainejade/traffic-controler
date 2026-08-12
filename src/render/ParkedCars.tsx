import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { VEHICLE_COLORS } from "../art/palette";
import { SKY } from "../art/daylight";
import { VEHICLE, type World } from "../sim/world";
import { UNIT_PLANE, blobTexture, carBodyGeometry } from "./vehicleArt";
import { LAYER } from "./layers";

/**
 * The cars at the kerb.
 *
 * They are not simulated — a parked car has no lane, no route and no
 * acceleration, and putting a thousand of them through the driving model to
 * have every one of them decide to stay still would be absurd. They are a
 * transform per occupied bay, rewritten only when a bay changes hands.
 *
 * Which is the whole reason this is a separate component from `Simulation`:
 * moving traffic is rewritten sixty times a second and parked traffic is
 * rewritten a handful of times a minute, and there is no sense in paying the
 * former's cost for the latter.
 */

/** Slots are laid out once; a Brooklyn half-kilometre comes to about 1500 bays. */
const MAX_PARKED = 3000;

/**
 * How far a parked car may sit off true, in radians and metres.
 *
 * Perfectly aligned bays read as a car park rather than a street. Real kerbside
 * parking is done by eye in one go and it shows.
 */
const YAW_JITTER = 0.035;
const ALONG_JITTER = 0.35;

/**
 * Pick a vehicle colour according to its configured weight.
 *
 * The seed is in [0, 1), so the result is deterministic for a given slot while
 * still respecting the relative weights in VEHICLE_COLORS.
 */
const totalColourWeight = VEHICLE_COLORS.reduce(
  (sum, colour) => sum + colour.weight,
  0,
);

const pickColour = (seed: number) => {
  let target = seed * totalColourWeight;

  for (const colour of VEHICLE_COLORS) {
    target -= colour.weight;

    if (target < 0) {
      return colour;
    }
  }

  // Protect against floating-point edge cases.
  return VEHICLE_COLORS[VEHICLE_COLORS.length - 1];
};

export function ParkedCars({ world }: { world: World }) {
  const bodies = useRef<THREE.InstancedMesh>(null);
  const shadows = useRef<THREE.InstancedMesh>(null);

  const geom = useMemo(() => carBodyGeometry(), []);
  const blob = useMemo(() => blobTexture(), []);

  const { slots } = world.parking;

  /*
   * Occupancy changes, so the transforms cannot simply be written once —
   * but they change on the order of once a second, not once a frame.
   * `revision` is bumped by the world whenever a bay changes hands,
   * and this rewrites only then.
   */
  const written = useRef(-1);

  const write = () => {
    const body = bodies.current;
    const shadow = shadows.current;
    if (!body || !shadow) return;

    const m = new THREE.Matrix4();
    const sm = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const colour = new THREE.Color();

    const spec = VEHICLE.car;
    const scale = new THREE.Vector3(spec.width, spec.height, spec.length);
    const shadowScale = new THREE.Vector3(
      spec.width * 2.1,
      1,
      spec.length * 1.5,
    );

    let n = 0;

    for (const slot of slots) {
      if (slot.occupant === null || n >= MAX_PARKED) continue;

      // Jitter is derived from the slot id, not sampled, so a bay looks the
      // same every time it is filled rather than twitching on each rewrite.
      const wobble = ((slot.id * 2654435761) >>> 0) / 4294967296;

      const angle = slot.angle + (wobble - 0.5) * 2 * YAW_JITTER;

      const nudge = (wobble - 0.5) * 2 * ALONG_JITTER;

      q.setFromAxisAngle(up, angle);

      pos.set(
        slot.x + Math.sin(angle) * nudge,
        0,
        slot.z + Math.cos(angle) * nudge,
      );

      m.compose(pos, q, scale);
      body.setMatrixAt(n, m);

      pos.y = LAYER.shadow;
      sm.compose(pos, q, shadowScale);
      shadow.setMatrixAt(n, sm);

      /*
       * Pick colour deterministically from the slot id, but use the colour's
       * configured weight rather than treating every colour equally.
       *
       * A separate hash from `wobble` avoids coupling the colour distribution
       * to the parking-position jitter.
       */
      const colourWobble =
        ((slot.id * 2246822519 + 3266489917) >>> 0) / 4294967296;

      const vehicleColour = pickColour(colourWobble);

      colour.set(vehicleColour.hex);
      body.setColorAt(n, colour);

      n++;
    }

    body.count = n;
    shadow.count = n;

    body.instanceMatrix.needsUpdate = true;
    shadow.instanceMatrix.needsUpdate = true;

    if (body.instanceColor) {
      body.instanceColor.needsUpdate = true;
    }
  };

  useLayoutEffect(() => {
    written.current = -1;
  }, [world]);

  useFrame(() => {
    if (written.current !== world.parking.revision) {
      written.current = world.parking.revision;
      write();
    }

    // The fake contact blobs fade out with the sun, exactly as the moving
    // traffic's do — a hard shadow under a car at midnight is the tell.
    const shadow = shadows.current;

    if (shadow) {
      (shadow.material as THREE.MeshBasicMaterial).opacity =
        1 - SKY.night * 0.85;
    }
  });

  return (
    <group>
      <instancedMesh ref={shadows} args={[UNIT_PLANE, undefined, MAX_PARKED]}>
        <meshBasicMaterial map={blob} transparent depthWrite={false} />
      </instancedMesh>

      <instancedMesh
        ref={bodies}
        args={[geom, undefined, MAX_PARKED]}
        castShadow
      >
        <meshLambertMaterial vertexColors />
      </instancedMesh>
    </group>
  );
}
