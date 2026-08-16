import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { LevelDef } from "../sim/types";
import { toggleLayer } from "../ui/hudStore";
import { typing } from "../ui/typing";
import { viewCentre } from "./viewCentre";

/** Metres. Standing eye height, so kerbs and signal heads read at their real scale. */
const EYE_HEIGHT = 1.7;
/** A little above a real walking pace — crossing a junction shouldn't be a chore. */
const WALK_SPEED = 4;
const FLY_SPEED = 30;
/** Shift multiplier, shared by both modes. */
const SPRINT = 4;
/** Flying never drops below knee height, and never leaves the map's own sky. */
const MIN_FLY_Y = 1;
const MAX_FLY_Y = 800;
/**
 * Never move more than this much wall time in one frame. A backgrounded tab
 * hands back a delta of whole seconds on its first frame, which with a key held
 * would teleport you across the map. Same guard, same reason, as the sim loop's
 * MAX_CATCHUP.
 */
const MAX_STEP = 0.1;
/** Radians of turn per pixel of mouse movement. */
const SENSITIVITY = 0.0022;
const MAX_PITCH = THREE.MathUtils.degToRad(89);

/**
 * First-person camera. WASD moves on the heading you are facing, the mouse
 * looks once the pointer is locked, F swaps walking for free flight, and Shift
 * sprints.
 *
 * Escape releases the mouse without leaving the mode, so the HUD's clock,
 * speed and layers stay reachable from street level; clicking the map again
 * takes the mouse back, and Escape with the mouse already free is what ends
 * the mode (as is unticking it in the layers menu).
 *
 * Like CinematicCamera this owns `camera.position`/`camera.rotation` outright,
 * so OrbitControls is unmounted for the duration (see Controls.tsx).
 */
export function WalkCamera({ level }: { level: LevelDef }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const yaw = useRef(0);
  const pitch = useRef(0);
  const keys = useRef(new Set<string>());
  const flying = useRef(false);
  const forward = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const step = useRef(new THREE.Vector3());

  /*
   * You start standing on the middle of the view you were just looking at, not
   * under the camera — the camera sits hundreds of metres outside the map, so
   * keeping its x/z would drop you in a corner every time. The centre is what
   * the previous camera wrote down each frame; the forward ray onto the ground
   * plane is the fallback for a camera that never reported one. Heading carries
   * over so the view doesn't spin on entry, and pitch starts level however
   * steeply you were looking down.
   */
  useEffect(() => {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    yaw.current = Math.atan2(-dir.x, -dir.z);
    pitch.current = 0;

    let x: number;
    let z: number;
    if (viewCentre.known) {
      x = viewCentre.point.x;
      z = viewCentre.point.z;
    } else {
      const t = dir.y < -1e-3 ? -camera.position.y / dir.y : 0;
      x = camera.position.x + dir.x * t;
      z = camera.position.z + dir.z * t;
    }

    const limit = level.half;
    camera.position.set(
      THREE.MathUtils.clamp(x, -limit, limit),
      EYE_HEIGHT,
      THREE.MathUtils.clamp(z, -limit, limit),
    );
    camera.rotation.set(0, yaw.current, 0, "YXZ");
    flying.current = false;
  }, [camera, level]);

  // Mouse look, on pointer lock — or on a held button where lock is refused.
  useEffect(() => {
    const el = gl.domElement;
    const locked = () => document.pointerLockElement === el;

    /*
     * Pointer lock is the whole point, but it is not always ours to have: an
     * embedding frame without `allow="pointer-lock"` rejects the request. Rather
     * than leave a camera that cannot turn, fall back to drag-to-look — the same
     * mouse deltas, gated on a held button instead of on the lock.
     */
    let lockRefused = false;
    let dragging = false;
    let everLocked = false;

    // Clicking the map takes the mouse back, however many times you let it go.
    const onClick = () => {
      if (locked() || lockRefused) return;
      const p = el.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        /*
         * A refusal only means "not supported here" if we never had the lock in
         * the first place. Once we have held it, a refusal is the browser's
         * short cool-down after an Escape — click again in a moment and it
         * works, so don't fall back to dragging over it.
         */
        if (!everLocked) lockRefused = true;
      });
    };

    const onDown = () => {
      if (lockRefused) dragging = true;
    };
    const onUp = () => {
      dragging = false;
    };

    const onMove = (e: MouseEvent) => {
      if (!locked() && !dragging) return;
      yaw.current -= e.movementX * SENSITIVITY;
      pitch.current = THREE.MathUtils.clamp(
        pitch.current - e.movementY * SENSITIVITY,
        -MAX_PITCH,
        MAX_PITCH,
      );
    };

    /*
     * Escape is the browser's own way out of a pointer lock and the page never
     * sees that keypress — it only sees the lock go away. That first Escape is
     * "give me my mouse back", not "leave the mode": the HUD is unreachable
     * while the pointer is captured, so releasing it is how you get at the
     * clock or the layers menu without losing your place in the street. The
     * next Escape does arrive as a keypress, and that one exits (see the key
     * handler below).
     */
    const onLockChange = () => {
      if (locked()) everLocked = true;
      else dragging = false;
    };

    el.addEventListener("click", onClick);
    el.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("pointerlockchange", onLockChange);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      if (document.pointerLockElement === el) document.exitPointerLock();
    };
  }, [gl]);

  /*
   * Held-key set, same shape as the orbit camera's WASD pan. Space is not bound
   * on purpose — the HUD already owns it for pause/play — so flying rises and
   * falls on Q and E.
   */
  useEffect(() => {
    const interesting = (k: string) =>
      k === "w" ||
      k === "a" ||
      k === "s" ||
      k === "d" ||
      k === "q" ||
      k === "e" ||
      k === "shift";

    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing()) return;
      /*
       * An Escape that reaches us at all is a second Escape: the first was
       * eaten by the browser releasing the pointer lock. Mouse already free,
       * so this one means leave.
       */
      if (e.key === "Escape") {
        if (!document.pointerLockElement) toggleLayer("walkCamera");
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "f") {
        flying.current = !flying.current;
        return;
      }
      if (interesting(k)) keys.current.add(k);
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

  useFrame((_, delta) => {
    const k = keys.current;
    const ahead = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0);
    const across = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
    const up = (k.has("e") ? 1 : 0) - (k.has("q") ? 1 : 0);

    if (ahead || across || up) {
      /*
       * Movement runs off the yaw alone, not the camera's forward vector:
       * looking up at a signal head shouldn't make W lift you off the pavement.
       */
      forward.current.set(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
      right.current.set(Math.cos(yaw.current), 0, -Math.sin(yaw.current));

      const speed =
        (flying.current ? FLY_SPEED : WALK_SPEED) *
        (k.has("shift") ? SPRINT : 1);

      const v = step.current.set(0, 0, 0);
      v.addScaledVector(forward.current, ahead);
      v.addScaledVector(right.current, across);
      if (v.lengthSq() > 0) v.normalize();
      if (flying.current) v.y = up;
      v.multiplyScalar(speed * Math.min(delta, MAX_STEP));

      camera.position.add(v);
    }

    // The ground card's top surface is exactly y = 0, and there is no terrain,
    // so walking is just a pinned height.
    const limit = level.half;
    camera.position.x = THREE.MathUtils.clamp(
      camera.position.x,
      -limit,
      limit,
    );
    camera.position.z = THREE.MathUtils.clamp(
      camera.position.z,
      -limit,
      limit,
    );
    camera.position.y = flying.current
      ? THREE.MathUtils.clamp(camera.position.y, MIN_FLY_Y, MAX_FLY_Y)
      : EYE_HEIGHT;

    camera.rotation.set(pitch.current, yaw.current, 0, "YXZ");
  });

  return null;
}
