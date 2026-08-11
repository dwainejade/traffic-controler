import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { PALETTE } from "../art/palette";
import { IDM } from "../sim/idm";
import { CAR_LENGTH, type World } from "../sim/world";
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

  // One tint quad per polyline *segment*, so the overlay follows a curved lane
  // instead of drawing a chord across the bend. Matrices are static; only the
  // per-lane colour changes frame to frame.
  const segments = useMemo(() => {
    const list: { lane: number; x: number; z: number; angle: number; len: number }[] = [];
    lanes.forEach((lane, li) => {
      for (let i = 1; i < lane.cum.length; i++) {
        const ax = lane.pts[(i - 1) * 2];
        const az = lane.pts[(i - 1) * 2 + 1];
        const bx = lane.pts[i * 2];
        const bz = lane.pts[i * 2 + 1];
        list.push({
          lane: li,
          x: (ax + bx) / 2,
          z: (az + bz) / 2,
          angle: Math.atan2(bx - ax, bz - az),
          // A hair of overlap hides the miter gaps between segments.
          len: lane.cum[i] - lane.cum[i - 1] + 0.15,
        });
      }
    });
    return list;
  }, [lanes]);

  const base = useMemo(() => new THREE.Color(PALETTE.road), []);
  const hot = useMemo(() => new THREE.Color("#7E4A3C"), []);

  useLayoutEffect(() => {
    const inst = mesh.current;
    if (!inst) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);

    segments.forEach((seg, i) => {
      q.setFromAxisAngle(up, seg.angle);
      m.compose(
        new THREE.Vector3(seg.x, Y, seg.z),
        q,
        new THREE.Vector3(LANE_WIDTH * 0.98, 1, seg.len),
      );
      inst.setMatrixAt(i, m);
    });
    inst.count = segments.length;
    inst.instanceMatrix.needsUpdate = true;
  }, [segments]);

  const laneColour = useMemo(() => lanes.map(() => new THREE.Color()), [lanes]);

  useFrame(() => {
    const inst = mesh.current;
    if (!inst) return;

    lanes.forEach((lane, i) => {
      const capacity = Math.max(1, lane.length / SLOT);
      const load = Math.min(1, lane.cars.length / capacity);
      // Stay invisible until a lane is genuinely filling, then ramp hard so a
      // near-full link is unmistakable.
      const t = load < 0.45 ? 0 : Math.pow((load - 0.45) / 0.55, 1.5);
      laneColour[i].copy(base).lerp(hot, t);
    });
    segments.forEach((seg, i) => {
      inst.setColorAt(i, laneColour[seg.lane]);
    });
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={mesh}
      args={[UNIT_PLANE, undefined, segments.length]}
      key={segments.length}
    >
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
