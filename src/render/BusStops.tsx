import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { PALETTE } from "../art/palette";
import { LANE_WIDTH } from "../sim/types";
import { VEHICLE, type World } from "../sim/world";
import { UNIT_PLANE } from "./vehicleArt";
import { LAYER } from "./layers";

/**
 * The painted box a bus pulls up to.
 *
 * Worth drawing for one reason: without it, the gap in the parked cars looks
 * like a mistake. The kerb runs solid for a hundred metres, then there is a
 * bus-length of nothing, and the only thing that explains it is the paint.
 *
 * Drawn on the bus lane rather than on the parking strip, because that is where
 * the bus actually stands — the lane is already at the kerb, so it does not need
 * to pull across anything to reach it.
 */

/** Over the bus lane it is painted on, under the lane markings. */
const Y = LAYER.stopBox;

export function BusStops({ world }: { world: World }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const stops = world.busStops;

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    // A shade longer than a bus, so the vehicle sits inside its own box.
    const scale = new THREE.Vector3(LANE_WIDTH * 0.92, 1, VEHICLE.bus.length * 1.15);

    stops.forEach((stop, i) => {
      q.setFromAxisAngle(up, stop.angle);
      m.compose(new THREE.Vector3(stop.x, Y, stop.z), q, scale);
      mesh.setMatrixAt(i, m);
    });
    mesh.count = stops.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [stops]);

  if (stops.length === 0) return null;

  return (
    <instancedMesh ref={ref} args={[UNIT_PLANE, undefined, stops.length]} receiveShadow>
      {/*
        Lit, not unlit. An emissive box sat on a Lambert-shaded bus lane read as
        a different material entirely — the box glowed and the lane it was
        painted on looked grey beside it. Both are paint on asphalt and both
        should take the same light.
      */}
      <meshLambertMaterial color={PALETTE.busLane} />
    </instancedMesh>
  );
}
