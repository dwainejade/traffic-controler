import { useEffect, useMemo, useRef } from "react";
import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useHud } from "../ui/hudStore";
import type { LevelDef } from "../sim/types";

/**
 * Orbit controls, deliberately fenced in. The player gets to look around and
 * zoom, but never into a view that breaks the readability the art direction is
 * built on: no going under the ground plane, no straight-down flatten, no
 * zooming past the point where the level card leaves the frame, and no panning
 * away from the level entirely.
 */
export function Controls({ level }: { level: LevelDef }) {
  const ref = useRef<OrbitControlsImpl>(null);
  const focus = useHud((s) => s.focus);
  const cinematic = useHud((s) => s.layers.cinematicCamera);
  const flyTo = useRef<{ target: THREE.Vector3; t: number } | null>(null);

  /*
   * Panning must reach the whole map. On a single junction a tight leash keeps
   * the level centred, but a city is far larger than one screen and its
   * congested junctions are, by definition, wherever you are not looking.
   */
  const half = level.half;
  const panLimit = half * 0.95;
  const minZoom = (370 / (half * Math.SQRT2)) * 0.85;
  const maxZoom = 26;

  /*
   * The perspective camera's equivalents. It has no zoom — how much map you see
   * is how far away you are — so the same two limits become a distance range:
   * close enough to stand at a junction, far enough to see the whole card.
   */
  const minDistance = 70;
  const maxDistance = half * 4.5;

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

  // The wheel handler and the key loop both live outside React's render, so
  // they read the clamp through a ref rather than closing over a stale one.
  const clampRef = useRef(clampTarget);
  clampRef.current = clampTarget;

  /*
   * Zoom towards the pointer rather than the screen centre. OrbitControls only
   * ever dollies about its target, which on a big map means the thing you are
   * aiming at slides out of frame as you close in. So we take the zoom over:
   * note the ground point under the cursor, apply the zoom, then shift the rig
   * by however far that point moved. The point stays pinned under the pointer.
   */
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const el = gl.domElement;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const before = new THREE.Vector3();
    const after = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const pivot = new THREE.Vector3();

    const groundUnderPointer = (x: number, y: number, out: THREE.Vector3) => {
      const rect = el.getBoundingClientRect();
      ndc.set(
        ((x - rect.left) / rect.width) * 2 - 1,
        -((y - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      return raycaster.ray.intersectPlane(plane, out);
    };

    /**
     * Zoom by `scale`, keeping whatever is under (x, y) under it.
     *
     * Shared by the wheel and by pinch, because they are the same gesture with
     * different hardware: a multiplier, and a point on screen it happens about.
     */
    const zoomAbout = (scale: number, x: number, y: number) => {
      const controls = ref.current;
      if (!controls || !controls.enabled) return;

      const anchored = groundUnderPointer(x, y, before) !== null;

      if (camera instanceof THREE.OrthographicCamera) {
        const next = THREE.MathUtils.clamp(camera.zoom * scale, minZoom, maxZoom);
        if (next === camera.zoom) return;
        camera.zoom = next;
        camera.updateProjectionMatrix();

        if (anchored && groundUnderPointer(x, y, after)) {
          const dx = before.x - after.x;
          const dz = before.z - after.z;
          controls.target.x += dx;
          controls.target.z += dz;
          camera.position.x += dx;
          camera.position.z += dz;
        }
      } else {
        /*
         * A perspective camera zooms by moving. Sliding it a fraction of the way
         * towards the ground point under the cursor is what keeps that point
         * pinned; the pivot is then re-derived by dropping the camera's own
         * forward ray onto the ground, so orbiting afterwards still turns about
         * whatever is in the middle of the screen.
         */
        camera.getWorldDirection(forward);
        if (forward.y > -1e-3) return; // Looking at or above the horizon.

        if (anchored) camera.position.lerp(before, 1 - 1 / scale);

        const t = -camera.position.y / forward.y;
        pivot.copy(camera.position).addScaledVector(forward, t);
        const distance = THREE.MathUtils.clamp(t, minDistance, maxDistance);
        camera.position.copy(pivot).addScaledVector(forward, -distance);
        controls.target.copy(pivot);
      }

      clampRef.current();
      controls.update();
    };

    const onWheel = (e: WheelEvent) => {
      const controls = ref.current;
      if (!controls || !controls.enabled) return;
      e.preventDefault();

      // Line- and page-mode wheels report in far smaller units than pixels.
      const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      zoomAbout(Math.exp(-e.deltaY * lines * 0.0016), e.clientX, e.clientY);
    };

    /*
     * Pinch.
     *
     * OrbitControls' own two-finger dolly is off along with the rest of its
     * zooming — it only ever zooms about its target, which on a city means the
     * thing you are pinching towards slides out of frame — so the gesture is
     * tracked here and fed through the same anchored zoom the wheel uses. Two
     * fingers still reach OrbitControls, where they orbit: spreading them zooms
     * and turning them rotates, which is how every map behaves.
     */
    const touches = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;

    const spread = () => {
      const [a, b] = [...touches.values()];
      return {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) pinchDistance = spread().distance;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size !== 2) return;

      const { distance, x, y } = spread();
      // Fingers landing at almost the same point make the first ratio enormous.
      if (pinchDistance < 12 || distance < 12) {
        pinchDistance = distance;
        return;
      }
      zoomAbout(distance / pinchDistance, x, y);
      pinchDistance = distance;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.delete(e.pointerId);
      // Lifting one of three fingers leaves a new pair at a new spread; measure
      // it fresh rather than scaling by the jump.
      if (touches.size === 2) pinchDistance = spread().distance;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, [camera, gl, minZoom, maxZoom, minDistance, maxDistance]);

  /*
   * WASD pans, in screen terms rather than world terms: W is always "up the
   * screen" whatever way the camera is currently facing, which is the only
   * reading that survives orbiting.
   */
  const keys = useRef(new Set<string>());

  useEffect(() => {
    const interesting = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      return k === "w" || k === "a" || k === "s" || k === "d";
    };
    // Don't steal keystrokes from the HUD's inputs.
    const typing = () => {
      const el = document.activeElement;
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      );
    };

    const down = (e: KeyboardEvent) => {
      if (!interesting(e) || e.metaKey || e.ctrlKey || e.altKey || typing()) return;
      keys.current.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const blur = () => keys.current.clear();

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Fly the camera to a junction when the congestion list is clicked.
  useEffect(() => {
    if (!focus) return;
    const node = level.nodes.find((n) => n.id === focus.id);
    if (!node) return;
    flyTo.current = {
      target: new THREE.Vector3(node.pos[0], 0, node.pos[1]),
      t: 0,
    };
  }, [focus, level]);

  const panAxis = useRef(new THREE.Vector3());

  /*
   * Keyboard pan, in world units per second, scaled by the zoom so a keypress
   * always crosses about the same amount of screen whether you are looking at
   * one junction or the whole city.
   */
  const panBy = (x: number, z: number, delta: number) => {
    const controls = ref.current;
    if (!controls || (!x && !z)) return;

    // Screen-relative either way: under ortho a screenful is 1/zoom of world,
    // under perspective it is proportional to how far away the camera is.
    const across =
      camera instanceof THREE.OrthographicCamera
        ? 520 / camera.zoom
        : camera.position.distanceTo(controls.target) * 0.55;
    const step = (across * delta) / Math.hypot(x, z);
    const v = panAxis.current;

    // Screen right, flattened onto the ground plane.
    v.setFromMatrixColumn(camera.matrix, 0);
    v.y = 0;
    v.normalize().multiplyScalar(x * step);
    controls.target.add(v);
    camera.position.add(v);

    // Column 2 points back towards the viewer, so +z reads as down-screen.
    v.setFromMatrixColumn(camera.matrix, 2);
    v.y = 0;
    v.normalize().multiplyScalar(z * step);
    controls.target.add(v);
    camera.position.add(v);

    clampRef.current();
    controls.update();
  };

  useFrame((_, delta) => {
    // CinematicCamera owns the camera transform directly while active, and
    // OrbitControls is unmounted below, so this ref is already null then —
    // but bail explicitly rather than relying on mount timing.
    if (cinematic) return;

    const controls = ref.current;
    if (!controls) return;

    if (controls.enabled && keys.current.size) {
      const k = keys.current;
      panBy(
        (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0),
        (k.has("s") ? 1 : 0) - (k.has("w") ? 1 : 0),
        delta,
      );
    }

    const trip = flyTo.current;
    if (!trip) return;

    trip.t += delta;
    // Ease in rather than snap, so you keep your bearings on a big map.
    controls.target.lerp(trip.target, 1 - Math.pow(0.004, delta));
    controls.update();

    if (trip.t > 1.2 || controls.target.distanceTo(trip.target) < 0.5) {
      flyTo.current = null;
    }
  });

  /*
   * Where OrbitControls should pick up when it remounts after cinematic mode
   * hands control back — the ground point the aerial camera was looking at,
   * found the same way the zoom pivot above is (drop the camera's forward
   * ray onto the ground plane). Without this the controls default to a
   * target at the map origin, which can leave the camera outside
   * minDistance/maxPolarAngle and snap on its very first update.
   *
   * Recomputed only when `cinematic` itself changes — the moment that
   * matters is true -> false, right as CinematicCamera has left the camera
   * mid-flight.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialTarget = useMemo(() => {
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const t = forward.y < -1e-3 ? -camera.position.y / forward.y : 0;
    const x = THREE.MathUtils.clamp(
      camera.position.x + forward.x * t,
      -panLimit,
      panLimit,
    );
    const z = THREE.MathUtils.clamp(
      camera.position.z + forward.z * t,
      -panLimit,
      panLimit,
    );
    return new THREE.Vector3(x, 0, z);
  }, [cinematic]);

  // Unmounted rather than merely disabled while cinematic is active: three's
  // OrbitControls recomputes the camera transform from its own target and
  // spherical state every frame it's mounted, which fights CinematicCamera
  // writing to camera.position/lookAt directly. See DevHandle.lookAt in
  // Scene.tsx for the same constraint on a smaller scale.
  if (cinematic) return null;

  return (
    <OrbitControls
      ref={ref}
      makeDefault
      target={initialTarget}
      onChange={clampTarget}
      enableDamping
      dampingFactor={0.08}
      // Below ~18° the view flattens to a plan and the buildings stop reading;
      // above ~68° you start looking through the model edge-on.
      minPolarAngle={THREE.MathUtils.degToRad(0)}
      maxPolarAngle={THREE.MathUtils.degToRad(82)}
      /*
       * Zoom limits scale with the map. A fixed floor of 1 is fine for a single
       * junction but on a city it is already tighter than the view that shows
       * the whole thing, so the camera would fight you the moment you touched
       * it. Out to the whole card, in to where individual cars read clearly.
       */
      minZoom={minZoom}
      maxZoom={maxZoom}
      minDistance={minDistance}
      maxDistance={maxDistance}
      // Zoom is handled above so it can track the pointer; OrbitControls only
      // ever zooms about its target.
      enableZoom={false}
      /*
       * On touch, one finger pans and two orbit — the map reading of the
       * gesture, and the opposite way round from the mouse, where dragging
       * rotates. Pinch is handled above and rides on top of the two-finger
       * orbit, so spreading zooms while turning rotates.
       */
      touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.ROTATE }}
      enablePan
      screenSpacePanning={false}
      rotateSpeed={0.6}
      panSpeed={0.8}
    />
  );
}
