import { useRef } from "react";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

/**
 * Orbit controls, deliberately fenced in. The player gets to look around and
 * zoom, but never into a view that breaks the readability the art direction is
 * built on: no going under the ground plane, no straight-down flatten, no
 * zooming past the point where the level card leaves the frame, and no panning
 * away from the level entirely.
 */
export function Controls({ half }: { half: number }) {
  const ref = useRef<OrbitControlsImpl>(null);

  // How far the look-at point may wander from the level centre.
  const panLimit = half * 0.55;

  const clampTarget = () => {
    const controls = ref.current;
    if (!controls) return;

    const t = controls.target;
    const x = THREE.MathUtils.clamp(t.x, -panLimit, panLimit);
    const z = THREE.MathUtils.clamp(t.z, -panLimit, panLimit);

    // Move the camera by the same correction so clamping reads as the pan
    // hitting a wall, rather than as the view snapping.
    if (x !== t.x || z !== t.z) {
      controls.object.position.x += x - t.x;
      controls.object.position.z += z - t.z;
      t.x = x;
      t.z = z;
    }

    // Keep the pivot on the ground plane so orbiting stays predictable.
    t.y = 0;
  };

  return (
    <OrbitControls
      ref={ref}
      makeDefault
      onChange={clampTarget}
      enableDamping
      dampingFactor={0.08}
      // Below ~18° the view flattens to a plan and the buildings stop reading;
      // above ~68° you start looking through the model edge-on.
      minPolarAngle={THREE.MathUtils.degToRad(18)}
      maxPolarAngle={THREE.MathUtils.degToRad(68)}
      minZoom={2.2}
      maxZoom={22}
      enablePan
      screenSpacePanning={false}
      rotateSpeed={0.6}
      zoomSpeed={0.9}
      panSpeed={0.8}
    />
  );
}
