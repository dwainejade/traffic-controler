import { useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Where the player is looking, and how big a metre is there.
 *
 * Lettering is the expensive half of every sign on the map — one text mesh
 * each, against instanced geometry for the boards themselves — so it is only
 * built where it would actually be read. That decision needs two numbers: the
 * ground point attention is on, and the pixels a metre covers there.
 *
 * Both cameras have to be asked differently, and the street-level camera has to
 * be asked without an orbit target at all: `Controls` is unmounted in walk mode
 * (and in cinematic), so anything keyed off `controls.target` silently letters
 * nothing exactly when the player is close enough to read it.
 */
export type TextAnchor = {
  /** Ground point to measure distance from. */
  x: number;
  z: number;
  pixelsPerMetre: number;
};

/** How far ahead the walker's attention sits, with no orbit target to ask. */
const WALK_FOCUS = 25;

export function useTextAnchor(): () => TextAnchor {
  const camera = useThree((s) => s.camera);
  const controls = useThree(
    (s) => s.controls as unknown as { target: THREE.Vector3 } | null,
  );
  const height = useThree((s) => s.size.height);
  const forward = useRef(new THREE.Vector3());

  return () => {
    if (camera instanceof THREE.OrthographicCamera) {
      const t = controls?.target;
      return {
        x: t?.x ?? camera.position.x,
        z: t?.z ?? camera.position.z,
        pixelsPerMetre: camera.zoom,
      };
    }

    if (!(camera instanceof THREE.PerspectiveCamera)) {
      return { x: 0, z: 0, pixelsPerMetre: 0 };
    }

    // With a target, the player is looking at it from wherever they orbited to.
    // Without one, they are looking out of their own eyes, and the honest
    // reading is a fixed distance down the eyeline: far enough to cover the
    // street in front of them, near enough that the whole map is not lettered.
    let x: number;
    let z: number;
    let distance: number;
    if (controls) {
      x = controls.target.x;
      z = controls.target.z;
      distance = camera.position.distanceTo(controls.target);
    } else {
      camera.getWorldDirection(forward.current);
      x = camera.position.x + forward.current.x * WALK_FOCUS;
      z = camera.position.z + forward.current.z * WALK_FOCUS;
      distance = WALK_FOCUS;
    }

    const frustum =
      2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance;
    return { x, z, pixelsPerMetre: height / frustum };
  };
}
