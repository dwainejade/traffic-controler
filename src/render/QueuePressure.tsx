import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { PALETTE } from "../art/palette";
import { IDM } from "../sim/idm";
import { CAR_LENGTH, type World } from "../sim/world";
import { sampleLane } from "../sim/network";
import { LANE_WIDTH } from "../sim/types";

/** Sits above the asphalt but below the painted markings. */
const Y = 0.042;

/** Space one queued car occupies at a standstill. */
const SLOT = CAR_LENGTH + IDM.s0;

const UNIT_PLANE = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/**
 * Tints each lane warm as it fills up.
 *
 * A lane that backs up all the way to the junction upstream is what strands a
 * car inside the box and causes a collision. Without a warning that reads at a
 * glance, that crash feels arbitrary; with one, "don't give green to a movement
 * with nowhere to go" becomes a thing the player can actually see coming.
 */
export function QueuePressure({ world }: { world: World }) {
  const mesh = useRef<THREE.InstancedMesh>(null);

  const lanes = useMemo(
    () => world.net.lanes.filter((l) => l.kind === "road"),
    [world],
  );

  const base = useMemo(() => new THREE.Color(PALETTE.road), []);
  const hot = useMemo(() => new THREE.Color("#7E4A3C"), []);

  useLayoutEffect(() => {
    const inst = mesh.current;
    if (!inst) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = { x: 0, z: 0, angle: 0 };

    lanes.forEach((lane, i) => {
      sampleLane(lane, lane.length / 2, p);
      q.setFromAxisAngle(up, p.angle);
      m.compose(
        new THREE.Vector3(p.x, Y, p.z),
        q,
        new THREE.Vector3(LANE_WIDTH * 0.98, 1, lane.length),
      );
      inst.setMatrixAt(i, m);
    });
    inst.count = lanes.length;
    inst.instanceMatrix.needsUpdate = true;
  }, [lanes]);

  useFrame(() => {
    const inst = mesh.current;
    if (!inst) return;

    const colour = new THREE.Color();
    lanes.forEach((lane, i) => {
      const capacity = Math.max(1, lane.length / SLOT);
      const load = Math.min(1, lane.cars.length / capacity);
      // Stay invisible until a lane is genuinely filling, then ramp hard so a
      // near-full link is unmistakable.
      const t = load < 0.45 ? 0 : Math.pow((load - 0.45) / 0.55, 1.5);
      colour.copy(base).lerp(hot, t);
      inst.setColorAt(i, colour);
    });
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[UNIT_PLANE, undefined, lanes.length]}>
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
