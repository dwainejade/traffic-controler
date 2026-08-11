import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { World } from "../sim/world";

/** Seconds the camera takes to settle on the impact. */
const PUSH_TIME = 1.1;
const PUSH_ZOOM = 2.6;
/** Seconds per pulse of the impact ring. */
const PULSE = 0.9;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * The crash beat. A run ending on one collision needs a moment that says
 * *there*, so the camera pushes in on the conflict point and an impact ring
 * pulses over it. Colour drain is handled in CSS over the canvas.
 */
export function CrashFocus({ world }: { world: World }) {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);

  const ring = useRef<THREE.Mesh>(null);
  const progress = useRef(0);
  const pulse = useRef(0);
  /** Zoom under ortho; distance to the target under perspective. */
  const baseZoom = useRef<number | null>(null);

  const target = useMemo(() => new THREE.Vector3(), []);
  const offset = useMemo(() => new THREE.Vector3(), []);
  const ringGeom = useMemo(
    () => new THREE.RingGeometry(0.78, 1, 48).rotateX(-Math.PI / 2),
    [],
  );

  /**
   * Set the perspective camera's distance from the pivot without turning it.
   * The push-in is a dolly there, since a perspective camera has no zoom.
   */
  const pullBack = (distance: number) => {
    if (!controls) return;
    offset.subVectors(camera.position, controls.target).setLength(distance);
    camera.position.copy(controls.target).add(offset);
  };

  useFrame((_, delta) => {
    const crash = world.crash;
    const mesh = ring.current;

    if (!crash) {
      // Hand the camera back on restart, exactly as we found it.
      if (baseZoom.current !== null) {
        if (camera instanceof THREE.OrthographicCamera) {
          camera.zoom = baseZoom.current;
          camera.updateProjectionMatrix();
        } else if (controls) {
          pullBack(baseZoom.current);
        }
        baseZoom.current = null;
      }
      if (controls) controls.enabled = true;
      progress.current = 0;
      pulse.current = 0;
      if (mesh) mesh.visible = false;
      return;
    }

    if (baseZoom.current === null) {
      baseZoom.current =
        camera instanceof THREE.OrthographicCamera
          ? camera.zoom
          : controls
            ? camera.position.distanceTo(controls.target)
            : camera.position.length();
    }

    progress.current = Math.min(1, progress.current + delta / PUSH_TIME);
    const eased = easeOut(progress.current);

    if (controls) {
      // Lock the player out while the beat plays.
      controls.enabled = false;
      target.set(crash.x, 0, crash.z);
      controls.target.lerp(target, 1 - Math.pow(0.001, delta));
      controls.update();
    }

    if (camera instanceof THREE.OrthographicCamera) {
      camera.zoom = THREE.MathUtils.lerp(
        baseZoom.current,
        baseZoom.current * PUSH_ZOOM,
        eased,
      );
      camera.updateProjectionMatrix();
    } else {
      // Same push, expressed as ground covered rather than magnification.
      pullBack(
        THREE.MathUtils.lerp(
          baseZoom.current,
          baseZoom.current / PUSH_ZOOM,
          eased,
        ),
      );
    }

    if (mesh) {
      pulse.current = (pulse.current + delta / PULSE) % 1;
      const p = pulse.current;
      mesh.visible = true;
      mesh.position.set(crash.x, 0.12, crash.z);
      const scale = 2.5 + p * 11;
      mesh.scale.set(scale, 1, scale);
      const material = mesh.material as THREE.MeshBasicMaterial;
      // Near-white rather than a saturated red: the CSS colour drain would
      // wash a red ring out, but a value contrast survives it.
      material.opacity = (1 - p) * 0.85;
    }
  });

  return (
    <mesh ref={ring} geometry={ringGeom} visible={false}>
      <meshBasicMaterial
        color="#FFFFFF"
        transparent
        opacity={0}
        depthWrite={false}
        toneMapped={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
